/**
 * dictate — minimal voice dictation for pi.
 *
 * Press ctrl+shift+m to start, press it again to stop.
 * Press ctrl+shift+n to cancel and discard the in-flight transcript.
 *
 * Focus-aware: the hotkeys are intercepted at the TUI input layer (before any
 * focused component), so dictation works inside ANY dialog — quiz popups,
 * ask_user_question, ctx.ui.editor()/input() — not just the main chat editor.
 *
 * Start rule: dictation only begins if some text-capable component is
 * focused; otherwise an ephemeral notification explains why nothing happened.
 * Opaque dialogs (quiz/ask selects) count as text-capable, but their internal
 * focus is invisible to us — Tab into the note/Other field first so the text
 * lands there.
 *
 * Stop rule: the delivery target is resolved fresh at stop time and the
 * transcript goes to whatever is focused THEN (editor-like components get a
 * direct setText append; opaque components get synthetic keystrokes). If
 * nothing text-capable is focused at stop, the transcript is copied to the
 * clipboard and a notification says so — a finished dictation is never lost.
 *
 * Requires:
 *   - pulseaudio-utils installed (`pacman -S pulseaudio-utils` — provides `parec`)
 *   - xclip installed (`pacman -S xclip` — clipboard fallback when no field is focused)
 *   - the local sherpa-onnx STT server (see wiki.techlab.icu/ai-hub/voice/sherpa-onnx)
 *
 * Config (environment, read at extension load):
 *   - DICTATE_STT_URL       — WebSocket URL of the STT server
 *                             (default: ws://mac-studio.lan:6006)
 *   - DICTATE_DEBUG         — "1" appends lifecycle events to
 *                             /tmp/dictate-debug.log (default: off)
 *
 * The live preview is a const at the top of the file (LIVE_PREVIEW),
 * not an environment variable.
 *
 * Streaming model: audio is sent to the local sherpa-onnx server while you
 * talk; the server transcribes in real time and emits one rolling text that
 * REPLACES itself on every update, plus one final after we send "DONE". On
 * stop we deliver the final (or the last rolling text if the connection
 * died). Nothing is shown in the editor until stop, so the editor never
 * shows revisable text.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, isKeyRelease, isKeyRepeat } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { appendFileSync } from "node:fs";

// ── Transcript state (sherpa protocol) ─────────────────────────────
// The sherpa server emits one rolling text per open stream (each update
// REPLACES the previous one — unlike Deepgram's per-utterance finals, which
// had to be joined) and one final after the client sends "DONE". This
// reducer folds incoming messages into that state. Pure and exported for
// index.test.ts.
export interface TranscriptState {
  /** Latest rolling text received from the server. */
  rolling: string;
  /** Latched final text; once set, further messages are ignored. */
  final: string | null;
}

export const initialTranscript: TranscriptState = { rolling: "", final: null };

export function applySherpaMessage(state: TranscriptState, data: unknown): TranscriptState {
  if (state.final !== null || typeof data !== "string") return state;
  let msg: { text?: unknown; is_final?: unknown };
  try {
    msg = JSON.parse(data);
  } catch {
    return state; // ignore non-JSON frames
  }
  if (msg.is_final === true) {
    return { ...state, final: typeof msg.text === "string" ? msg.text : "" };
  }
  if (typeof msg.text === "string") {
    return { ...state, rolling: msg.text };
  }
  return state;
}

// Optional forensic logging: run pi with DICTATE_DEBUG=1 to append timestamped
// lifecycle events (listener hits, toggles, ws open/error/close with their
// generation) to /tmp/dictate-debug.log.
const DEBUG = !!process.env.DICTATE_DEBUG;
const dbg = (msg: string) => {
  if (!DEBUG) return;
  try {
    appendFileSync("/tmp/dictate-debug.log", `${new Date().toISOString()} ${msg}\n`);
  } catch {}
};

// Local sherpa-onnx server (see wiki.techlab.icu/ai-hub/voice/sherpa-onnx).
// Protocol: binary int16 PCM @16kHz in, JSON {"text", is_final} out. The
// rolling text REPLACES itself on every update; the string "DONE" requests
// the final. The server never closes the connection on its own — the client
// must close it (cleanup does).
const STT_URL = process.env.DICTATE_STT_URL ?? "ws://mac-studio.lan:6006";

// Optional live preview of the rolling text in the status row.
const LIVE_PREVIEW = false;
const PREVIEW_MAX_CHARS = 96;

type State = "idle" | "recording" | "stopping";

// ── Focus-aware delivery ──────────────────────────────────────────────────
// The TUI handle is captured once via a zero-height widget factory (the only
// extension-API surface that exposes it). With it we can:
//   1. Listen to ALL terminal input via tui.addInputListener — listeners run
//      before the focused component, so ctrl+shift+m works even while a custom
//      dialog has stolen focus from the main editor (extension shortcuts are
//      otherwise only matched by the main editor component).
//   2. Inspect tui.focusedComponent to decide where the transcript goes.
// `focusedComponent` is declared private in the typings but is a plain
// runtime property — a benign peek, easily patched if pi internals change.
interface EditorLike {
  getText(): string;
  setText(text: string): void;
}
type Target =
  { kind: "editor"; editor: EditorLike } | { kind: "typable"; component: { handleInput(data: string): void } };

const asEditorLike = (value: any): EditorLike | null =>
  value && typeof value.getText === "function" && typeof value.setText === "function" ? value : null;

// Hotkeys: ctrl+shift+m/n. Verified against the user's terminal (st, CSI-u /
// Kitty protocol): \x1b[109;6u (m) and \x1b[110;6u (n). The previous alt+m/n
// binding collided with dwm's window-manager shortcuts. pi-tui parses the
// VTE-style modifier order (;6 = shift|ctrl) correctly.
export const DICTATE_TOGGLE_KEY = Key.ctrlShift("m");
export const DICTATE_CANCEL_KEY = Key.ctrlShift("n");

// Same braille frames pi-tui's Loader uses.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// Audio meter — a tiny rolling waveform rendered in the status row while recording.
// Tweakable knobs:
//   METER_CELLS       = how many bars wide
//   METER_TICK_MS     = how often bars shift left (smaller = snappier, more renders)
//   METER_FLOOR_DB    = level at which the bar is empty (more negative = more sensitive)
//   METER_CEILING_DB  = level at which the bar is full (less negative = needs louder to peg)
const METER_CELLS = 6;
const METER_TICK_MS = 60;
const PEAK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
// const PEAK_BLOCKS = ["⠀", "⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"];
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;

/** Map a normalized RMS value to one of PEAK_BLOCKS by converting to dB and clamping into the visible range. */
function rmsToBlock(rms: number): string {
  if (rms <= 0) return PEAK_BLOCKS[0]!;
  const db = 20 * Math.log10(rms);
  const t = Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)));
  const idx = Math.floor(t * (PEAK_BLOCKS.length - 1));
  return PEAK_BLOCKS[idx]!;
}

// ── Downsampling: 48 kHz stereo → 16 kHz mono ────────────────────────────
// Capture runs at 48 kHz/stereo (native) because sox's rec delivered
// stdout in 32 kB blocks (~170 ms at this rate) and its 48k→16k conversion
// path in ~1 s blocks — both too coarse for the level meter and the rolling
// text. The 3:1 decimation happens in-process: L/R downmix, then a 25-tap
// Hann-windowed sinc lowpass (cutoff 8 kHz, ~-40 dB stopband) evaluated at a
// stride of 3. A 3-point box average was not enough — the E2E A/B against
// sox's resampler misheard a word (see index.test.ts + the A/B runs).
// Pure and exported for index.test.ts.
const DS_TAPS: number[] = (() => {
  const N = 25;
  const alpha = (N - 1) / 2;
  const fc = 8000 / 48000; // cutoff relative to the source rate
  const taps = new Array<number>(N);
  for (let n = 0; n < N; n++) {
    const x = n - alpha;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));
    taps[n] = sinc * hann;
  }
  const gain = taps.reduce((a, b) => a + b, 0);
  return taps.map((v) => v / gain); // unit DC gain
})();

/**
 * Streaming 48 kHz stereo s16le → 16 kHz mono s16le decimator.
 * `feed` returns the downsampled bytes for one input chunk; internal state
 * (partial frame + FIR history) carries across chunks, so the output of
 * chunked feeds is bit-identical to a single feed of the concatenated input.
 */
export function createDownsampler(): { feed: (chunk: Buffer) => Buffer } {
  let tail = Buffer.alloc(0); // partial stereo frame (< 4 bytes)
  let hist: number[] = []; // mono samples starting at the next output base
  return {
    feed(input: Buffer): Buffer {
      const data = tail.length ? Buffer.concat([tail, input]) : input;
      const frames = Math.floor(data.length / 4);
      if (frames * 4 < data.length) tail = Buffer.from(data.subarray(frames * 4));
      else tail = Buffer.alloc(0);
      if (frames === 0) return Buffer.alloc(0);
      // L/R downmix to mono (int32 so the sum is exact)
      const mono = new Int32Array(frames);
      for (let f = 0; f < frames; f++) {
        mono[f] = (data.readInt16LE(f * 4) + data.readInt16LE(f * 4 + 2)) / 2;
      }
      const all = hist.concat(Array.from(mono));
      // Output o needs input samples [o*3 .. o*3+24]; the first 25 samples
      // prime the window.
      const outSamples = Math.max(0, Math.floor((all.length - DS_TAPS.length) / 3));
      const out = Buffer.alloc(outSamples * 2);
      for (let o = 0; o < outSamples; o++) {
        const base = o * 3;
        let s = 0;
        for (let k = 0; k < DS_TAPS.length; k++) s += DS_TAPS[k] * all[base + k];
        let v = Math.round(s);
        if (v > 32767) v = 32767;
        else if (v < -32768) v = -32768;
        out.writeInt16LE(v, o * 2);
      }
      // Next output base is 3*outSamples; the window for it starts there.
      hist = all.slice(3 * outSamples);
      return out;
    },
  };
}

export default function (pi: ExtensionAPI) {
  let state: State = "idle";
  let rec: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let ws: WebSocket | null = null;
  let transcript: TranscriptState = initialTranscript;
  let activeCtx: ExtensionContext | null = null;
  let flushed = false;
  let cancelled = false;
  let stopTimeout: NodeJS.Timeout | null = null;
  let spinnerTimer: NodeJS.Timeout | null = null;
  let spinnerFrame = 0;
  // Session generation: incremented on every start and every cleanup. All
  // rec/ws event handlers capture the generation they belong to and no-op
  // when it's stale — otherwise a PREVIOUS session's socket erroring/closing
  // late (e.g. one we aborted mid-handshake) would run cleanup() and tear
  // down the CURRENT live session.
  let generation = 0;
  // Audio meter state. `meter` is a ring of recent RMS values, newest at
  // index METER_CELLS-1. `currentLevel` is the RMS of the most recent 16ms
  // window of the downsampled stream — the meter tick just samples it.
  // Crucially we never reset it: ticks between chunk arrivals re-render the
  // last observed value, so the bars never drop to silence just because no
  // chunk happened to arrive in that window.
  let meterTimer: NodeJS.Timeout | null = null;
  let meter: number[] = new Array(METER_CELLS).fill(0);
  let currentLevel = 0;
  let meterWinCount = 0;
  let meterWinSumSq = 0;
  const METER_WINDOW = 256; // 16ms @ 16 kHz

  const setStatus = (msg: string | undefined) => {
    if (!activeCtx) return;
    activeCtx.ui.setStatus("dictate", msg);
  };

  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  };

  const stopMeter = () => {
    if (meterTimer) {
      clearInterval(meterTimer);
      meterTimer = null;
    }
  };

  /** Start the meter ticking. Each tick shifts the ring and samples currentLevel. */
  const startMeter = () => {
    stopMeter();
    meter = new Array(METER_CELLS).fill(0);
    currentLevel = 0;
    meterWinCount = 0;
    meterWinSumSq = 0;
    // Recording dot: a text glyph colored via the theme, not an emoji — emoji
    // presentation renders double-width in its own baked-in color and visually
    // shouts in the footer. `●` is the same dot pi's own docs use for
    // indicators; theme "error" gives the red. (If you ever want strictly
    // ASCII, swap the glyph for "O".)
    const render = () => {
      const dot = activeCtx?.ui.theme.fg("error", "●") ?? "●";
      const bars = meter.map(rmsToBlock).join("");
      if (!LIVE_PREVIEW) {
        setStatus(`${dot} ${bars} listening…`);
        return;
      }
      // Live preview: sample the rolling text on the same tick as the meter.
      let text = transcript.rolling.replace(/\s+/g, " ").trim();
      if (text.length > PREVIEW_MAX_CHARS) text = `…${text.slice(-(PREVIEW_MAX_CHARS - 1))}`;
      setStatus(text ? `${dot} ${bars} ${text}` : `${dot} ${bars} listening…`);
    };
    render();
    meterTimer = setInterval(() => {
      meter.shift();
      meter.push(currentLevel);
      render();
    }, METER_TICK_MS);
  };

  /** Animate the dictate status row with a braille spinner + suffix message. */
  const startSpinner = (suffix: string) => {
    stopSpinner();
    spinnerFrame = 0;
    setStatus(`${SPINNER_FRAMES[0]} ${suffix}`);
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      setStatus(`${SPINNER_FRAMES[spinnerFrame]} ${suffix}`);
    }, SPINNER_INTERVAL_MS);
  };

  let tuiHandle: any = null;
  let removeInputListener: (() => void) | null = null;
  let lastCtx: ExtensionContext | null = null;

  /** Resolve where dictated text would go RIGHT NOW, based on keyboard focus. */
  const resolveTarget = (): Target | null => {
    const focused = tuiHandle?.focusedComponent;
    if (!focused) return null;
    // Editor-like focus: the main chat editor, custom editors, and the
    // ctx.ui.editor()/input() popups (their inner pi-tui Editor hangs off
    // `.editor`). These accept a guaranteed direct setText append.
    const editor = asEditorLike(focused) ?? asEditorLike(focused.editor);
    if (editor) return { kind: "editor", editor };
    // Opaque component with input handling (quiz/ask selects, selectors):
    // we can type into it, but whether the text lands depends on its
    // internal focus (e.g. the quiz note field must be Tab-focused).
    if (typeof focused.handleInput === "function") return { kind: "typable", component: focused };
    return null;
  };

  const flush = () => {
    if (flushed || !activeCtx) return;
    flushed = true;
    if (cancelled) return; // discard transcript on cancel
    // Final wins; the last rolling text is the best-effort fallback when the
    // connection died before the final arrived.
    const text = (transcript.final ?? transcript.rolling).replace(/\s+/g, " ").trim();
    if (!text) return;

    // Legacy fallback: no TUI handle captured (non-TUI mode / older pi) —
    // append to the main chat editor exactly as before.
    if (!tuiHandle) {
      const current = activeCtx.ui.getEditorText() ?? "";
      const sep = current && !/\s$/.test(current) ? " " : "";
      activeCtx.ui.setEditorText(current + sep + text);
      return;
    }

    // Resolve the target NOW — focus may have changed while dictating.
    const target = resolveTarget();
    if (target?.kind === "editor") {
      const current = target.editor.getText() ?? "";
      const sep = current && !/\s$/.test(current) ? " " : "";
      target.editor.setText(current + sep + text);
      tuiHandle.requestRender?.();
      return;
    }
    if (target?.kind === "typable") {
      // Synthetic typing: the component routes the text wherever its
      // internal focus is. Text is plain printable words (whitespace
      // already normalized), so no keybindings/autocomplete can trigger.
      target.component.handleInput(text);
      tuiHandle.requestRender?.();
      return;
    }
    // Nothing to type into: don't throw the transcript away — stash it on
    // the X11 clipboard and say so.
    try {
      const p = spawn("xclip", ["-selection", "clipboard"], { stdio: ["pipe", "ignore", "ignore"] });
      // Crash-proof: neither a spawn failure (ENOENT) nor an early xclip
      // death (EPIPE on stdin) may take pi down.
      p.on("error", () => {});
      p.stdin.on("error", () => {});
      p.stdin.end(text);
    } catch {}
    activeCtx.ui.notify("Dictation finished but no input field is focused — transcript copied to clipboard", "warning");
  };

  const cleanup = () => {
    generation++; // invalidate the dying session's event handlers
    dbg(`cleanup → gen ${generation}`);
    flush();
    stopSpinner();
    stopMeter();
    if (stopTimeout) {
      clearTimeout(stopTimeout);
      stopTimeout = null;
    }
    if (rec) {
      try {
        rec.kill("SIGTERM");
      } catch {}
      rec = null;
    }
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {}
      ws = null;
    }
    transcript = initialTranscript;
    state = "idle";
    setStatus(undefined);
    activeCtx = null;
    flushed = false;
    cancelled = false;
  };

  const startDictation = (ctx: ExtensionContext) => {
    activeCtx = ctx;
    transcript = initialTranscript;
    flushed = false;
    cancelled = false;
    state = "recording";
    const myGeneration = ++generation;
    dbg(`start (gen ${myGeneration})`);
    startMeter();

    // Spawn parec to capture 48 kHz / 16-bit / stereo PCM to stdout
    // (native — the 3:1 decimation to 16 kHz/mono happens in-process).
    let proc: ChildProcessByStdio<null, Readable, Readable>;
    try {
      proc = spawn(
        "parec",
        [
          "--raw", // raw PCM to stdout, no file header
          "--rate=48000",
          "--channels=2",
          // explicit — parec's default format is s16ne (network byte order)
          "--format=s16le",
          // Server-side buffer: ~50 ms chunks (9600 B at this rate).
          // Measured: sox `rec` delivers 32 kB blocks regardless of
          // --buffer (170 ms at this rate, ~1 s in its conversion path) —
          // too coarse for the level meter and the rolling text.
          "--latency-msec=50",
          "--process-time-msec=50",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e: any) {
      ctx.ui.notify("Failed to spawn 'parec'. Install pulseaudio-utils: pacman -S pulseaudio-utils", "error");
      cleanup();
      return;
    }
    rec = proc;
    let recErr = "";
    proc.stderr?.on("data", (c: Buffer) => {
      recErr = (recErr + String(c)).slice(-400);
    });

    proc.on("error", (err) => {
      if (myGeneration !== generation) return;
      ctx.ui.notify(`parec error: ${err.message} (install pulseaudio-utils: pacman -S pulseaudio-utils)`, "error");
      cleanup();
    });

    proc.on("exit", (code) => {
      if (myGeneration !== generation) return; // stale recorder — a newer/ended session owns state
      // Natural exit on SIGTERM during stopDictation is fine. Anything else
      // mid-recording is a problem.
      if (state === "recording" && code !== null && code !== 0) {
        if (activeCtx) {
          activeCtx.ui.notify(
            `parec exited unexpectedly (code ${code})${recErr ? `: ${recErr.trim()}` : ""}`,
            "warning",
          );
        }
        cleanup();
      }
    });

    // Open the STT WebSocket (no auth — it's a local service).
    try {
      ws = new WebSocket(STT_URL);
    } catch (e: any) {
      ctx.ui.notify(`STT WS failed (${STT_URL}): ${e.message}`, "error");
      cleanup();
      return;
    }

    ws.addEventListener("open", () => {
      if (myGeneration !== generation) {
        dbg(`ws open (stale gen ${myGeneration}, current ${generation}) — ignored`);
        return;
      }
      dbg(`ws open (gen ${myGeneration})`);
      if (!rec || !ws) return;
      const ds = createDownsampler();
      rec.stdout.on("data", (chunk: Buffer) => {
        const out = ds.feed(chunk);
        if (out.length === 0) return;
        // Meter: RMS per 16ms window of the downsampled stream. Chunks
        // arrive ~every 170ms, so each burst fills ~10 windows and
        // currentLevel ends up on the newest one.
        for (let i = 0; i < out.length; i += 2) {
          const s = out.readInt16LE(i);
          meterWinSumSq += s * s;
          if (++meterWinCount === METER_WINDOW) {
            currentLevel = Math.sqrt(meterWinSumSq / METER_WINDOW) / 32768;
            meterWinCount = 0;
            meterWinSumSq = 0;
          }
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(out);
        }
      });
    });

    ws.addEventListener("message", (ev) => {
      if (myGeneration !== generation) return;
      const next = applySherpaMessage(transcript, ev.data);
      if (next === transcript) return; // no state change (non-JSON / post-final)
      transcript = next;
      dbg(
        `transcript (gen ${myGeneration}, final=${next.final !== null}): ` + JSON.stringify(next.final ?? next.rolling),
      );
      // The final only matters while we're waiting for it; otherwise it's a
      // protocol surprise — latch it, stopDictation will finalize at once.
      if (next.final !== null && state === "stopping") {
        cleanup();
      }
    });

    ws.addEventListener("error", () => {
      if (myGeneration !== generation) {
        dbg(`ws error (stale gen ${myGeneration}, current ${generation}) — ignored`);
        return;
      }
      dbg(`ws error (gen ${myGeneration})`);
      if (activeCtx) activeCtx.ui.notify(`STT server error (${STT_URL})`, "error");
      cleanup();
    });

    ws.addEventListener("close", (ev) => {
      if (myGeneration !== generation) {
        dbg(`ws close (stale gen ${myGeneration}, current ${generation}, code ${ev.code}) — ignored`);
        return;
      }
      dbg(`ws close (gen ${myGeneration}, code ${ev.code})`);
      // Server-initiated close (or our own close in cleanup): finalize.
      if (state === "recording" || state === "stopping") {
        cleanup();
      }
    });
  };

  /** Stop dictation, finalize transcript, append to editor. */
  const stopDictation = () => {
    if (state !== "recording") return;
    // The final already arrived — finalize immediately, no round-trip needed.
    if (transcript.final !== null) {
      cleanup();
      return;
    }
    state = "stopping";
    stopMeter();
    startSpinner("finalizing…");

    // Stop the mic first so no more audio enqueues.
    if (rec) {
      try {
        rec.kill("SIGTERM");
      } catch {}
    }

    // Ask the server for the final; it sends one {"text", is_final: true}
    // message and (by protocol) keeps the connection open — the message
    // handler finalizes, or the timeout below flushes the last rolling text.
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send("DONE");
      } catch {
        cleanup();
        return;
      }
      // Safety net: if the final never arrives, force cleanup after 3s —
      // flush then delivers the last rolling text (best effort).
      stopTimeout = setTimeout(() => {
        if (state === "stopping") cleanup();
      }, 3000);
    } else {
      cleanup();
    }
  };

  /** Cancel dictation: discard any collected transcript and tear everything down immediately. */
  const cancelDictation = () => {
    if (state !== "recording" && state !== "stopping") return;
    cancelled = true;
    transcript = initialTranscript;
    // No need to wait for the final — we're throwing the result away.
    cleanup();
  };

  /** Toggle dictation, gated on there being somewhere for the text to go. */
  const toggleDictation = (ctx: ExtensionContext) => {
    lastCtx = ctx;
    if (state === "idle") {
      if (tuiHandle && !resolveTarget()) {
        ctx.ui.notify("No input field is focused — dictation not started", "warning");
        return;
      }
      startDictation(ctx);
    } else if (state === "recording") {
      stopDictation();
    }
    // Ignore presses during the "stopping" state — the server is finalizing.
  };

  // Global input listener: catches ctrl+shift+m/n before ANY focused
  // component, which is what makes dictation work inside dialogs. Registered
  // once the TUI handle is captured (see session_start below).
  const onGlobalInput = (data: string) => {
    // Kitty flag-2 terminals send press + REPEAT + RELEASE events, and input
    // listeners run BEFORE the TUI's release filter (that filter only guards
    // dispatch to the focused component). matchesKey also ignores the Kitty
    // event type. Without this guard a single physical hotkey press toggles
    // TWICE: press starts dictation, release instantly stops it and closes
    // the WebSocket mid-handshake — which then surfaces as
    // "STT server error" (and its stale error event can kill the NEXT
    // session). Filter to press events only.
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
    if (matchesKey(data, DICTATE_TOGGLE_KEY)) {
      dbg(`ctrl+shift+m (data=${JSON.stringify(data)}) state=${state}`);
      if (lastCtx) toggleDictation(lastCtx);
      return { consume: true };
    }
    if (matchesKey(data, DICTATE_CANCEL_KEY)) {
      dbg(`ctrl+shift+n (data=${JSON.stringify(data)}) state=${state}`);
      cancelDictation();
      return { consume: true };
    }
    return undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    if (ctx.mode !== "tui" || tuiHandle) return;
    // Capture the TUI handle via an invisible zero-height widget. The
    // listener function reference is stable, so even if the factory re-runs
    // the TUI's listener Set de-dupes it.
    ctx.ui.setWidget("dictate-tui-handle", (tui: any) => {
      tuiHandle = tui;
      removeInputListener = tui.addInputListener(onGlobalInput);
      return { render: () => [], invalidate: () => {} };
    });
  });

  // Shortcut registrations kept as a fallback for contexts where the TUI
  // handle was never captured (non-TUI modes, older pi): they only fire when
  // the main editor is focused, but that's precisely the legacy path. When
  // the listener IS installed it consumes the key first, so no double-fire.
  pi.registerShortcut(DICTATE_TOGGLE_KEY, {
    description: "Toggle voice dictation (local sherpa-onnx)",
    handler: async (ctx) => {
      toggleDictation(ctx);
    },
  });

  // Dedicated cancel binding. Dictation-only — a no-op when no dictation is
  // in flight, so it's safe to hammer without affecting anything else.
  pi.registerShortcut(DICTATE_CANCEL_KEY, {
    description: "Cancel voice dictation (discard transcript)",
    handler: async () => {
      cancelDictation();
    },
  });

  pi.on("session_shutdown", () => {
    if (state !== "idle") cleanup();
    removeInputListener?.();
    removeInputListener = null;
  });
}
