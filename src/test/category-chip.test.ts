import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import {
  CATEGORY_CHIP_NODE,
  CategoryChip,
  categoryFromDoc,
  insertReportCategory,
} from "../components/agent/composer/categoryChip";
import {
  placeholderSelection,
  serializePlainText,
} from "../components/agent/composer/ComposerEditor";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function makeEditor() {
  return new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, CategoryChip],
    content: "",
  });
}

function chipCount(doc: ProseMirrorNode) {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === CATEGORY_CHIP_NODE) count += 1;
  });
  return count;
}

describe("category chip insertion", () => {
  it("inserts a single chip with one trailing space", () => {
    editor = makeEditor();
    insertReportCategory(editor, "bug");
    expect(chipCount(editor.state.doc)).toBe(1);
    expect(categoryFromDoc(editor.state.doc)).toBe("bug");
    // One separator space, no leading space.
    expect(serializePlainText(editor.state.doc)).toBe(" ");
  });

  it("swaps the chip without stranding an extra space", () => {
    editor = makeEditor();
    insertReportCategory(editor, "bug");
    insertReportCategory(editor, "feedback");
    // Still exactly one chip, now feedback...
    expect(chipCount(editor.state.doc)).toBe(1);
    expect(categoryFromDoc(editor.state.doc)).toBe("feedback");
    // ...and still just the single trailing space (not the doubled "  " the
    // orphaned separator used to leave behind).
    expect(serializePlainText(editor.state.doc)).toBe(" ");
  });
});

describe("run-shortcut placeholder selection", () => {
  it("maps the <placeholder> token to its document range", () => {
    // "Research <topic>" — the doc range must span "<topic>" inclusive so a run
    // shortcut highlights it for the user to overtype.
    const prompt = "Research <topic>";
    const range = placeholderSelection(prompt);
    expect(range).toEqual({ from: 10, to: 17 });
    // The selected slice (positions shifted back by the paragraph boundary) is
    // exactly the placeholder token.
    expect(prompt.slice(range!.from - 1, range!.to - 1)).toBe("<topic>");
  });

  it("returns null when there is no placeholder to select", () => {
    expect(placeholderSelection("Summarize my notes")).toBeNull();
    expect(placeholderSelection("a > b but no opener")).toBeNull();
  });
});
