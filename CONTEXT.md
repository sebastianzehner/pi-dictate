# pi-dictate

Pi extension that transcribes speech into the focused text field via a local
streaming STT server, triggered by hotkeys.

## Language

**STT server**:
The local sherpa-onnx WebSocket service that accepts a raw PCM stream and
emits transcripts for it.
_Avoid_: cloud backend (the former Deepgram integration), ASR service

**Rolling text**:
The server's current best-effort transcript for the open stream. Each update
replaces the previous one; it is not appended.
_Avoid_: partial, interim

**Final**:
The server's definitive transcript for a stream, emitted after the client
signals end of audio.
_Avoid_: result

**Transcript**:
The delivered dictation output: the final text of a session, inserted into
the focused text field on stop.
_Avoid_: output, text

**Live preview**:
Optional status-line rendering of the rolling text while recording.
_Avoid_: partials display
