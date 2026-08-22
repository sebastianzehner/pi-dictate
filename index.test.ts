import test from "node:test";
import assert from "node:assert/strict";
import { matchesKey, setKittyProtocolActive } from "@earendil-works/pi-tui";
import {
  applySherpaMessage,
  createDownsampler,
  initialTranscript,
  DICTATE_CANCEL_KEY,
  DICTATE_TOGGLE_KEY,
  type TranscriptState,
} from "./index.ts";

// Verified sequences from the user's terminal (st, CSI-u / Kitty protocol).
// ctrl+shift modifier order is VTE-style (;6 = shift|ctrl); pi-tui parses it
// as such. Regression guard for the dwm hotkey collision fix.
setKittyProtocolActive(true);

const msg = (text: string, isFinal: boolean) =>
  JSON.stringify({ text, is_final: isFinal });

test("rolling message updates the rolling text", () => {
  const s: TranscriptState = applySherpaMessage(initialTranscript, msg("Hallo", false));
  assert.equal(s.rolling, "Hallo");
  assert.equal(s.final, null);
});

test("rolling message replaces the previous rolling text", () => {
  let s = applySherpaMessage(initialTranscript, msg("Hallo", false));
  s = applySherpaMessage(s, msg("Hallo Welt.", false));
  assert.equal(s.rolling, "Hallo Welt.");
  assert.equal(s.final, null);
});

test("final message latches the final text", () => {
  let s = applySherpaMessage(initialTranscript, msg("Hallo", false));
  s = applySherpaMessage(s, msg("Hallo Welt.", true));
  assert.equal(s.final, "Hallo Welt.");
});

test("final without preceding rolling latches the empty text (silence case)", () => {
  const s = applySherpaMessage(initialTranscript, msg("", true));
  assert.equal(s.final, "");
});

test("messages after the final are ignored", () => {
  let s = applySherpaMessage(initialTranscript, msg("Erst.", true));
  s = applySherpaMessage(s, msg("Später.", false));
  s = applySherpaMessage(s, msg("Noch später.", true));
  assert.equal(s.final, "Erst.");
  assert.equal(s.rolling, "");
});

test("non-JSON and non-string messages are ignored", () => {
  let s = applySherpaMessage(initialTranscript, "garbage not json");
  s = applySherpaMessage(s, JSON.stringify({ is_final: false })); // no text field
  assert.equal(s.rolling, "");
  assert.equal(s.final, null);
});

// ── Hotkeys (seam S2) ──────────────────────────────────────────────────
// The verified terminal sequences MUST match the exported key ids, so the
// dwm collision fix (alt+m/n -> ctrl+shift+m/n) can't silently regress.

test("toggle key matches the verified ctrl+shift+m press sequence", () => {
  assert.ok(matchesKey("\x1b[109;6u", DICTATE_TOGGLE_KEY));
});

test("cancel key matches the verified ctrl+shift+n press sequence", () => {
  assert.ok(matchesKey("\x1b[110;6u", DICTATE_CANCEL_KEY));
});

test("toggle key does NOT match the old alt+m sequence", () => {
  assert.ok(!matchesKey("\x1bm", DICTATE_TOGGLE_KEY));
});

test("keys are distinct from each other", () => {
  assert.ok(!matchesKey("\x1b[109;6u", DICTATE_CANCEL_KEY));
  assert.ok(!matchesKey("\x1b[110;6u", DICTATE_TOGGLE_KEY));
});

// ── Downsampling (48 kHz stereo → 16 kHz mono) ─────────────────────

test("downsample: constant stereo input stays constant mono (unit DC gain)", () => {
  // 1s of 48k stereo at value 1000 (L=R=1000)
  const input = Buffer.alloc(48000 * 2 * 2);
  for (let i = 0; i < input.length; i += 2) input.writeInt16LE(1000, i);
  const out = createDownsampler().feed(input);
  // 48000 input samples → floor((48000 - 25) / 3) output samples (FIR priming)
  assert.equal(out.length, 2 * Math.floor((48000 - 25) / 3));
  for (let i = 0; i < out.length; i += 2) assert.equal(out.readInt16LE(i), 1000);
});

test("downsample: chunked feed (mid-frame split) == single feed", () => {
  // 50ms of a 1 kHz sine at 48k stereo (L=R)
  const frames = 2400;
  const full = Buffer.alloc(frames * 4);
  for (let f = 0; f < frames; f++) {
    const s = Math.round(10000 * Math.sin((2 * Math.PI * 1000 * f) / 48000));
    full.writeInt16LE(s, f * 4);
    full.writeInt16LE(s, f * 4 + 2);
  }
  const outWhole = createDownsampler().feed(full);
  const ds = createDownsampler();
  const split = 4002; // mid-frame on purpose (4002 % 4 = 2)
  const outA = ds.feed(full.subarray(0, split));
  const outB = ds.feed(full.subarray(split));
  assert.deepEqual(Buffer.concat([outA, outB]), outWhole);
});

test("downsample: priming — no output until 28 frames accumulated", () => {
  const frame = Buffer.alloc(4);
  frame.writeInt16LE(500, 0);
  frame.writeInt16LE(500, 2);
  const ds = createDownsampler();
  for (let i = 0; i < 27; i++) assert.equal(ds.feed(Buffer.from(frame)).length, 0);
  const out = ds.feed(Buffer.from(frame)); // 28th frame
  assert.equal(out.length, 2);
  assert.equal(out.readInt16LE(0), 500);
});
