# dictate

Minimal voice dictation for [pi][1], transcribed by a **local** [sherpa-onnx][2] server.
No floating bubbles, no menu bar app, no cloud, no API key.

Repository: [sebastianzehner/pi-dictate](https://github.com/sebastianzehner/pi-dictate)

Fork of [amosblomqvist/pi-dictate](https://github.com/amosblomqvist/pi-dictate), ported to a local sherpa-onnx backend
and native Linux (X11/PulseAudio) capture — see [What changed](#what-changed) below.

- **Toggle:** `ctrl+shift+m` (start, then stop) — works anywhere in pi: chat input, quiz popups,
  ask_user_question, editor dialogs, selectors, intercepted before whatever has focus.
- **Cancel:** `ctrl+shift+n` — discards the in-flight transcript, safe to press anytime.
- **Where text goes:** the focused input **when you stop**, always appended, never replaces:
  - Editor or popup input → appended directly.
  - Opaque dialogs (quiz, ask_user_question) → typed as keystrokes; **Tab into the note/Other field first**.
  - Nothing focused → copied to the clipboard (`xclip`), with a notification.
- **Start guard:** no focused input → dictation doesn't start, a notification explains why.
- **Live feedback:** a red `●` plus a real-time mic-level meter (`● ▂▅▇ listening…`).
  Set `LIVE_PREVIEW = true` in `index.ts` to also show the rolling transcript.
  On stop: a brief `finalizing…` spinner, usually too fast to notice on a local server.
- **Backend:** local sherpa-onnx server, [de-kroko-2025-08-06][3] (German streaming Zipformer).
  Handles common English words too; swap in any other sherpa-onnx model server-side for other languages.
- **Real-time:** transcribed while you talk, inserted in one shot on stop.
  Typically tens of milliseconds over the LAN, punctuation included natively.

## What changed

Everything that differs from the upstream project:

- **Backend:** Deepgram Nova-3 (cloud, API key) → local sherpa-onnx server, no API key, no cost.
- **Platform:** macOS → Linux (X11, PulseAudio/PipeWire), see Requirements below.
- **Capture:** `sox`/`rec` → `parec`, native 48 kHz with an in-process FIR downsampler, see [How it works](#how-it-works).
- **Hotkeys:** `alt+m`/`alt+n` → `ctrl+shift+m`/`ctrl+shift+n`, avoiding a dwm shortcut collision.
- **Clipboard fallback:** `pbcopy` → `xclip`.

## Requirements

Linux with X11 and PulseAudio/PipeWire (`pulseaudio-utils`, for `parec`).
Wayland isn't supported yet: `xclip` needs X11, would need a `wl-copy` fallback.

## Install

```bash
pi install git:github.com/sebastianzehner/pi-dictate
```

Or manually: copy `index.ts` to `~/.pi/agent/extensions/dictate/index.ts`.

## Setup

```bash
pacman -S pulseaudio-utils xclip   # pulseaudio-utils provides `parec`
```

The STT server must be running (Docker, default port 6006):

```bash
docker compose -f <path-to-sherpa-compose>/compose.yaml up -d
```

Verify reachability: `ss -tlnp | grep 6006` (server host), or
`timeout 2 bash -c 'exec 3<>/dev/tcp/<host>/6006 && echo open'` (pi host).

## Configuration

Environment variables, read when the extension loads (restart pi after changes):

| Variable          | Default                    | Effect                                                   |
| ----------------- | -------------------------- | -------------------------------------------------------- |
| `DICTATE_STT_URL` | `ws://mac-studio.lan:6006` | WebSocket URL of the sherpa-onnx server                  |
| `DICTATE_DEBUG`   | off                        | `1` appends lifecycle events to `/tmp/dictate-debug.log` |

## Usage

1. Focus any pi input field — chat input, quiz note field, ask_user_question answer box.
2. Press `ctrl+shift+m` — status row shows `● ▁▂▃▅ listening…`, bars move with your voice.
3. Talk.
4. Press `ctrl+shift+m` again — spinner (`⠋ finalizing…`), then the text lands in the focused input.
   Focus is resolved fresh at stop time, so text goes wherever is focused then, not where you started.

Run `/reload` after install or after editing `index.ts`.

## How it works

- `parec` captures 48 kHz stereo PCM natively (50 ms buffer); an in-process FIR filter decimates it 3:1 to the
  16 kHz mono the server expects.
- A WebSocket pipes the PCM to the local sherpa-onnx server as binary frames.
- The server replies with JSON `{"text", "is_final"}`: a rolling text that replaces itself each update, then one
  final after `DONE`.
  The server doesn't close the connection, so the client does.
- On stop: the final if it arrived, otherwise the last rolling text (best effort), or a 3s timeout forces it.
- The level meter maps each chunk's RMS to a bar glyph, shifted through a 6-cell ring every 60ms.
- **Focus-aware delivery:** an input listener runs before the focused component, so hotkeys work inside dialogs
  too.
  Key release/repeat events are filtered so one press toggles once.
  On stop: editor-like components get a direct text append; opaque components (dialogs) get it as synthetic
  keystrokes.

## Hotkeys and terminals

Hotkeys are `ctrl+shift`-based because `alt+m`/`alt+n` collided with dwm shortcuts.
Requires the terminal to emit CSI-u (Kitty protocol): `\x1b[109;6u` (m), `\x1b[110;6u` (n).

- **st**: `mappedkeys[]` in `config.h` adjusted to emit them (terminal-side, not in this repo).
- **tmux** (3.5+): forward modified keys in CSI-u form, or `ctrl+shift+m` collapses to Enter:

  ```text
  set -g extended-keys on
  set -g extended-keys-format csi-u
  ```

  See [https://pi.dev/docs/latest/tmux](https://pi.dev/docs/latest/tmux) for the full pi-on-tmux keyboard guide.

## Customizing

All knobs are at the top of `index.ts`:

- **Hotkeys:** `DICTATE_TOGGLE_KEY` / `DICTATE_CANCEL_KEY`, pinned by `index.test.ts` against the verified sequences.
- **STT server / debug:** the `DICTATE_*` environment variables (see Configuration).
- **Live preview:** `LIVE_PREVIEW` (default off), `PREVIEW_MAX_CHARS` (width, tail-truncated).
- **Level meter:** `METER_CELLS`, `METER_TICK_MS`, `METER_FLOOR_DB`/`METER_CEILING_DB` (loudness range).

## Testing

```bash
npm run check   # tsc --noEmit
npm test        # node --test (reducer + hotkey seams, no network)
```

## Troubleshooting

- **"STT server error (ws://…)"** — server unreachable: check `docker ps`, the port, and firewall/route.
  `DICTATE_DEBUG=1` logs the WebSocket lifecycle to `/tmp/dictate-debug.log`.
- **"Failed to spawn `parec`"** — `pacman -S pulseaudio-utils`, verify with `which parec`.
- **No mic input** — check the level meter: flat bars while talking means no audio is reaching `parec`.
  PulseAudio/PipeWire: make sure the terminal is allowed to open the default source.
- **Nothing happens after stop** — errors surface as pi notifications.
  "No input field focused" means the transcript went to the clipboard instead — paste with `ctrl+shift+v`.
- **Text vanished into a quiz/ask dialog** — the option list, not its text field, had focus.
  Tab into the note/Other field before toggling dictation.
- **Hotkeys don't fire in tmux** — it's collapsing `ctrl+shift+m` to Enter; enable `extended-keys` as shown above.
- **Garbage English transcription** — the model is German (`de-kroko`), though it usually gets English words
  right too; use an English model if you dictate mostly English.
- **Need logs?** `DICTATE_DEBUG=1` appends timestamped lifecycle events to `/tmp/dictate-debug.log`.

## License

MIT, see [LICENSE](./LICENSE).

[1]: https://github.com/earendil-works/pi
[2]: https://github.com/k2-fsa/sherpa-onnx
[3]: https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-de-kroko-2025-08-06/tree/main
