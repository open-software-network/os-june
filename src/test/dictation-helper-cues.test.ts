import { describe, expect, it } from "vitest";
import buildSource from "../../src-tauri/build.rs?raw";
import helperSource from "../../src-tauri/native/mac-dictation-helper/main.swift?raw";

describe("dictation helper cues", () => {
  it("plays a bundled cue when transcription is ready", () => {
    expect(helperSource).toContain('case complete = "record-complete"');
    expect(helperSource).toMatch(
      /emit\("final_transcript", \["text": text\]\)\s*if playCompletionSound \{\s*RecordingCuePlayer\.play\(\.complete\)\s*\}/,
    );
    expect(helperSource).toContain(
      'let playCompletionSound = command?["playCompletionSound"] as? Bool ?? true',
    );
    expect(buildSource).toContain('"record-complete.wav"');
  });
});
