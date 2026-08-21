import test from "node:test";
import assert from "node:assert/strict";
import { matchesKey, setKittyProtocolActive } from "@earendil-works/pi-tui";
import {
  applySherpaMessage,
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
