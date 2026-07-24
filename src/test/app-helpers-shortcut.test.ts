import { describe, expect, it } from "vitest";
import {
  isCreateNoteShortcut,
  isNewSessionShortcut,
  isStopDictationShortcut,
} from "../app/app-helpers";

function key(init: Partial<KeyboardEventInit> & { key: string }) {
  return new KeyboardEvent("keydown", init);
}

describe("isStopDictationShortcut", () => {
  it("matches bare Escape", () => {
    expect(isStopDictationShortcut(key({ key: "Escape" }))).toBe(true);
  });

  it("rejects Escape with any modifier", () => {
    expect(isStopDictationShortcut(key({ key: "Escape", metaKey: true }))).toBe(false);
    expect(isStopDictationShortcut(key({ key: "Escape", ctrlKey: true }))).toBe(false);
    expect(isStopDictationShortcut(key({ key: "Escape", altKey: true }))).toBe(false);
    expect(isStopDictationShortcut(key({ key: "Escape", shiftKey: true }))).toBe(false);
  });

  it("does not shadow the existing new-session / create-note chords or bare n", () => {
    const newSession = key({ key: "n", metaKey: true });
    const createNote = key({ key: "n", metaKey: true, shiftKey: true });
    const bareN = key({ key: "n" });
    for (const event of [newSession, createNote, bareN]) {
      expect(isStopDictationShortcut(event)).toBe(false);
    }
    // Sanity: those chords still match their own predicates, so nothing regressed.
    expect(isNewSessionShortcut(newSession)).toBe(true);
    expect(isCreateNoteShortcut(createNote)).toBe(true);
  });

  it("rejects other stop-adjacent keys (Cmd+T, W)", () => {
    expect(isStopDictationShortcut(key({ key: "t", metaKey: true }))).toBe(false);
    expect(isStopDictationShortcut(key({ key: "w", metaKey: true }))).toBe(false);
  });
});
