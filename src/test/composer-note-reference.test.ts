import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import { CATEGORY_CHIP_NODE, CategoryChip } from "../components/agent/composer/categoryChip";
import {
  buildDoc,
  composerDocumentEdge,
  composerScrollMargin,
  serializePlainText,
} from "../components/agent/composer/ComposerEditor";
import {
  NOTE_REFERENCE_NODE,
  createNoteReference,
  filterNoteSuggestions,
  insertNoteReference,
  noteReferenceToken,
} from "../components/agent/composer/noteReference";
import type { NoteListItemDto } from "../lib/tauri";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function makeEditor() {
  return new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, CategoryChip, createNoteReference({ fetchNotes: async () => [] })],
    content: "",
  });
}

function note(id: string, title: string, preview = ""): NoteListItemDto {
  return {
    id,
    title,
    preview,
    processingStatus: "ready",
    folderIds: [],
    createdAt: "2026-07-03T00:00:00Z",
    updatedAt: "2026-07-03T00:00:00Z",
  };
}

function nodeCount(doc: ProseMirrorNode, name: string) {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === name) count += 1;
  });
  return count;
}

describe("composer scrolling", () => {
  it("keeps the caret clear of the shared fade as well as editor padding", () => {
    expect(composerScrollMargin("18px", "6px")).toBe(18);
    expect(composerScrollMargin("", "6px")).toBe(6);
  });

  it("identifies only the selectable document edges", () => {
    expect(composerDocumentEdge(1, 20)).toBe("start");
    expect(composerDocumentEdge(10, 20)).toBeNull();
    expect(composerDocumentEdge(19, 20)).toBe("end");
  });
});

describe("note reference token", () => {
  it("serializes a normal title", () => {
    expect(noteReferenceToken({ id: "note-1", title: "Launch plan" })).toBe(
      '@note:note-1 ("Launch plan")',
    );
  });

  it("omits the title when sanitizing leaves it empty", () => {
    expect(noteReferenceToken({ id: "note-2", title: ' \n "" \t ' })).toBe("@note:note-2");
  });

  it("collapses whitespace, strips quotes, trims, and caps the title", () => {
    const longTitle = `${"A".repeat(40)}\n"${"B".repeat(60)}"`;

    expect(noteReferenceToken({ id: "note-3", title: longTitle })).toBe(
      `@note:note-3 ("${`${"A".repeat(40)} ${"B".repeat(60)}`.slice(0, 80)}")`,
    );
  });
});

describe("note reference serialization", () => {
  it("serializes text with one note chip", () => {
    editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Review " },
            { type: NOTE_REFERENCE_NODE, attrs: { noteId: "note-1", title: "Launch plan" } },
            { type: "text", text: " before standup" },
          ],
        },
      ],
    });

    expect(serializePlainText(editor.state.doc)).toBe(
      'Review @note:note-1 ("Launch plan") before standup',
    );
  });

  it("serializes multiple note chips", () => {
    editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: NOTE_REFERENCE_NODE, attrs: { noteId: "note-1", title: "Launch plan" } },
            { type: "text", text: " and " },
            { type: NOTE_REFERENCE_NODE, attrs: { noteId: "note-2", title: "Retro" } },
          ],
        },
      ],
    });

    expect(serializePlainText(editor.state.doc)).toBe(
      '@note:note-1 ("Launch plan") and @note:note-2 ("Retro")',
    );
  });

  it("serializes a chip-only document", () => {
    editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: NOTE_REFERENCE_NODE, attrs: { noteId: "note-1", title: "Launch plan" } },
          ],
        },
      ],
    });

    expect(serializePlainText(editor.state.doc)).toBe('@note:note-1 ("Launch plan")');
  });

  it("keeps category chips out of the serialized text", () => {
    editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: CATEGORY_CHIP_NODE, attrs: { category: "bug" } }],
        },
      ],
    });

    expect(serializePlainText(editor.state.doc)).toBe("");
  });
});

describe("note reference insertion", () => {
  it("inserts an atom with a trailing space", () => {
    editor = makeEditor();
    insertNoteReference(editor, { id: "note-1", title: "Launch plan" });

    expect(nodeCount(editor.state.doc, NOTE_REFERENCE_NODE)).toBe(1);
    expect(serializePlainText(editor.state.doc)).toBe('@note:note-1 ("Launch plan") ');
  });

  it("allows two note references to coexist", () => {
    editor = makeEditor();
    insertNoteReference(editor, { id: "note-1", title: "Launch plan" });
    insertNoteReference(editor, { id: "note-2", title: "Retro" });

    expect(nodeCount(editor.state.doc, NOTE_REFERENCE_NODE)).toBe(2);
    expect(serializePlainText(editor.state.doc)).toBe(
      '@note:note-1 ("Launch plan") @note:note-2 ("Retro") ',
    );
  });
});

describe("draft rehydration", () => {
  it("rebuilds a note chip from a persisted token", () => {
    editor = makeEditor();
    editor.commands.setContent(
      buildDoc('@note:note-1 ("Launch plan") what were the action items?'),
    );

    expect(nodeCount(editor.state.doc, NOTE_REFERENCE_NODE)).toBe(1);
    editor.state.doc.descendants((node) => {
      if (node.type.name !== NOTE_REFERENCE_NODE) return true;
      expect(node.attrs.noteId).toBe("note-1");
      expect(node.attrs.title).toBe("Launch plan");
      return false;
    });
  });

  it("round-trips a restored draft losslessly", () => {
    const draft = 'before @note:note-1 ("Launch plan") between @note:note-2 after';
    editor = makeEditor();
    editor.commands.setContent(buildDoc(draft));

    expect(nodeCount(editor.state.doc, NOTE_REFERENCE_NODE)).toBe(2);
    expect(serializePlainText(editor.state.doc)).toBe(draft);
  });

  it("leaves plain text without tokens untouched", () => {
    const doc = buildDoc("just a line\nand another");
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0].content).toEqual([{ type: "text", text: "just a line" }]);
  });

  it("skips rehydration when asked, keeping placeholder position math valid", () => {
    const line = '@note:note-1 ("Launch plan") ask about it';
    const doc = buildDoc(line, null, { rehydrateNoteTokens: false });
    expect(doc.content[0].content).toEqual([{ type: "text", text: line }]);
  });
});

describe("note suggestion filtering", () => {
  const notes = [
    note("note-1", "Launch plan"),
    note("note-2", "Customer retro"),
    note("note-3", "Engineering roadmap"),
    note("note-4", "Launch follow-up"),
  ];

  it("matches title substrings case-insensitively", () => {
    expect(filterNoteSuggestions(notes, "LAUNCH", 8).map((item) => item.id)).toEqual([
      "note-1",
      "note-4",
    ]);
  });

  it("respects the result limit", () => {
    expect(filterNoteSuggestions(notes, "launch", 1).map((item) => item.id)).toEqual(["note-1"]);
  });

  it("returns the head of the list for an empty query", () => {
    expect(filterNoteSuggestions(notes, "", 2).map((item) => item.id)).toEqual([
      "note-1",
      "note-2",
    ]);
  });

  it("matches the preview so untitled notes are still findable", () => {
    const withPreview = [
      note("note-1", "New note", "quarterly budget review"),
      note("note-2", "New note", "team offsite planning"),
    ];
    expect(filterNoteSuggestions(withPreview, "budget", 8).map((item) => item.id)).toEqual([
      "note-1",
    ]);
  });

  it("ranks title matches above preview-only matches", () => {
    const mixed = [
      note("preview-only", "New note", "launch checklist"),
      note("title-hit", "Launch plan", ""),
    ];
    expect(filterNoteSuggestions(mixed, "launch", 8).map((item) => item.id)).toEqual([
      "title-hit",
      "preview-only",
    ]);
  });
});
