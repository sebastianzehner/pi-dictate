# dictate

Minimal voice dictation for pi, transcribed by a **local** sherpa-onnx server.
No floating bubbles, no menu bar app, no cloud, no API key.


- **Toggle:** `ctrl+shift+m` (press to start, press again to stop) — works
  **anywhere in pi**, not just the main chat input: quiz popups,
  `ask_user_question`, `ctx.ui.editor()`/`input()` dialogs, selectors. The key
  is intercepted at the TUI input layer, before whatever component has focus.
- **Cancel:** `ctrl+shift+n` (discard the in-flight transcript; safe to press
  anytime, no-op when no dictation is in flight)
- **Where text goes:** to whatever input field is focused **when you stop**
  (never replaces, always appends):
  - Main chat editor or any `ctx.ui.editor()`/`input()` popup → appended
    directly.
  - Opaque dialogs (quiz / ask_user_question selects) → typed in as
    keystrokes. Their internal focus is invisible to the extension, so
    **Tab into the note/Other field first** — that's where the text will land.
  - Nothing text-capable focused → transcript is copied to the X11 clipboard
    (via `xclip`) and a notification says so. A finished dictation is never
    lost.
- **Start guard:** if no input field is focused when you press the toggle,
  dictation doesn't start and a notification explains why.
- **Live feedback:** while recording, the status row shows a red `●` plus a
  real-time mic-level meter (`● ▂▅▇ listening…`). With `DICTATE_LIVE_PREVIEW=1`
  the rolling transcript is rendered in the same row — instant confirmation
  that recognition is following your voice. On stop it flips to a
  `finalizing…` spinner.
- **Backend:** local sherpa-onnx streaming server
  (German streaming Zipformer, `de-kroko-2025-08-06`), see
  [wiki.techlab.icu/ai-hub/voice/sherpa-onnx](https://wiki.techlab.icu/ai-hub/voice/sherpa-onnx)
- **What's "real-time":** audio is transcribed *while you talk*; the
  finalized text is inserted in one shot when you stop.
  Stop-to-display latency is typically a few tens of milliseconds over the
  LAN.
  The model emits punctuation natively.

## Install

```bash
pi install git:https://git.techlab.icu/sebastianzehner/pi-dictate
```

Or manually: copy `index.ts` to `~/.pi/agent/extensions/dictate/index.ts`.

## Setup

```bash
pacman -S sox xclip        # sox provides `rec` for audio capture
```

The STT server must be running (Docker, default port 6006):

```bash
docker compose -f <path-to-sherpa-compose>/compose.yaml up -d
```

Verify reachability: `ss -tlnp | grep 6006` on the server host, or
`timeout 2 bash -c 'exec 3<>/dev/tcp/<host>/6006 && echo open'` from the pi
host.

## Configuration

Environment variables, read when the extension loads (restart pi after
changes):

| Variable             | Default                   | Effect                                              |
| -------------------- | ------------------------- | --------------------------------------------------- |
| `DICTATE_STT_URL`    | `ws://mac-studio.lan:6006`| WebSocket URL of the sherpa-onnx server             |
| `DICTATE_LIVE_PREVIEW` | off                     | `1` renders the rolling transcript in the status row |
| `DICTATE_DEBUG`      | off                       | `1` appends lifecycle events to `/tmp/dictate-debug.log` |

## Usage

1. Focus any pi input field — the main chat input, a quiz note field, an
   `ask_user_question` answer box.
2. Press `ctrl+shift+m`.
   The status row shows a red `●` with a live mic-level meter:
   `● ▁▂▃▅ listening…`.
   The bars move with your voice — if they stay flat, no audio is reaching
   the extension.
3. Talk.
4. Press `ctrl+shift+m` again.
   The meter is replaced by a braille spinner (`⠋ finalizing…`), then the
   text appears in the focused input.

Focus is resolved fresh at stop time, so if a dialog opened (or focus moved)
while you were talking, the text goes to whatever is focused at that moment.

Run `/reload` in pi after first install (or after editing `index.ts`) to pick
up changes.

## How it works

- The extension spawns `rec` (sox) capturing 16kHz mono 16-bit PCM to stdout.
- It opens a WebSocket to the local sherpa-onnx server and pipes the PCM
  stream in as binary frames.
- The server answers with JSON `{"text", "is_final"}`: while you talk, a
  single rolling text that **replaces** itself on every update.
  After we send the string `DONE`, one final arrives.
  Unlike per-utterance finals, nothing needs joining.
  The server keeps the connection open afterwards, so the client closes it.
- The transcript is delivered on stop: the final if it arrived, otherwise the
  last rolling text (best effort, e.g. after an abrupt disconnect).
  A 3s timeout forces finalization if the final never comes.
  The editor never shows revisable text.
- While recording, each audio chunk's RMS loudness is mapped to a bar glyph
  and shifted through a 6-cell ring every 60ms — the live level meter in the
  status row.
- **Focus-aware delivery:** the extension captures pi's `TUI` instance once
  (via an invisible zero-height widget) and installs a `tui.addInputListener`
  handler.
  Listeners run *before* the focused component, which is why the hotkeys work
  inside dialogs (extension shortcuts are otherwise only matched by the main
  editor).
  Kitty-protocol key **release/repeat** events are filtered out, so one
  physical press toggles exactly once.
  On stop it inspects `tui.focusedComponent`: editor-like components (anything
  with `getText`/`setText`, including popups' inner `.editor`) get a direct
  append; opaque components get the text as synthetic keystrokes routed by
  their own focus logic.

## Hotkeys and terminals

The hotkeys are `ctrl+shift`-based because `alt+m`/`alt+n` collided with
dwm's window-manager shortcuts on the primary workstation.
That requires the terminal to emit them in **CSI-u (Kitty protocol) form** —
verified sequences: `\x1b[109;6u` (ctrl+shift+m) and `\x1b[110;6u`
(ctrl+shift+n).
pi-tui parses the VTE-style modifier order (`;6` = shift|ctrl) correctly.

- **st**: the `mappedkeys[]` table in `config.h` is adjusted to emit the
  CSI-u sequences (terminal-side config, not part of this repo).
- **tmux** (3.5+): forward modified keys in CSI-u form or the bindings
  collapse to their legacy bytes (`ctrl+shift+m` → Enter):

  ```
  set -g extended-keys on
  set -g extended-keys-format csi-u
  ```

  See https://pi.dev/docs/latest/tmux for the full pi-on-tmux keyboard guide.

## Customizing

All knobs are at the top of `index.ts`:

- **Hotkeys:** the `DICTATE_TOGGLE_KEY` / `DICTATE_CANCEL_KEY` constants
  (`Key.ctrlShift("m")` / `Key.ctrlShift("n")`) — used by the input listener
  `onGlobalInput` and the fallback `pi.registerShortcut` calls, and pinned by
  `index.test.ts` against the verified terminal sequences.
- **STT server / live preview / debug:** the `DICTATE_*` environment
  variables (see Configuration).
- **Level meter:** `METER_CELLS` (width in bars), `METER_TICK_MS` (update
  rate), `METER_FLOOR_DB` / `METER_CEILING_DB` (loudness range mapped to
  empty/full bars), `PREVIEW_MAX_CHARS` (live-preview width).

## Testing

```bash
npm run check   # tsc --noEmit
npm test        # node --test (reducer + hotkey seams, no network)
```

## Troubleshooting

- **"STT server error (ws://…)"** — the server isn't reachable from the pi
  host.
  Check the container is up (`docker ps`), the port is published, and the
  route/firewall allow the connection.
  `DICTATE_DEBUG=1` shows the WebSocket lifecycle in
  `/tmp/dictate-debug.log`.
- **"Failed to spawn 'rec'" / "rec error"** — `pacman -S sox`, verify with
  `which rec`.
- **No mic input** — first check the level meter: if the bars stay flat while
  you talk, no audio is reaching sox.
  PulseAudio/PipeWire users: make sure the terminal (or st) is allowed to open
  the default source.
- **Nothing happens after stop** — errors are surfaced as pi notifications.
  If you saw "no input field is focused", the transcript was copied to the
  clipboard — paste with `ctrl+shift+v` (or your terminal's paste binding).
- **Dictated text vanished into a quiz/ask dialog** — the dialog's option
  list (not its text field) had focus. Tab into the note/Other field before
  toggling dictation.
- **Hotkeys don't fire in tmux** — tmux is collapsing `ctrl+shift+m` to
  Enter because it isn't forwarding modified keys; enable `extended-keys` as
  shown above.
- **Garbage transcription of English words** — the model is German
  (`de-kroko`); foreign terms are misrecognized by design.
  Dictate the German equivalent or type the term.
- **Need lifecycle logs?** Run pi with `DICTATE_DEBUG=1` — the extension
  appends timestamped events (key hits, toggles, WebSocket open/error/close
  with their session generation, transcript updates) to
  `/tmp/dictate-debug.log`.
