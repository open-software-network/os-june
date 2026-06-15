import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import {
  CATEGORY_CHIP_NODE,
  CategoryChip,
  categoryFromDoc,
  insertReportCategory,
} from "../components/agent/composer/categoryChip";
import { serializePlainText } from "../components/agent/composer/ComposerEditor";
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
