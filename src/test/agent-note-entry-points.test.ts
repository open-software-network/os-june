import type { Editor } from "@tiptap/react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_NEW_SESSION_PENDING_KEY,
  markAgentNewSessionPending,
  pendingNewSessionRequest,
} from "../components/agent/AgentWorkspace";
import { ComposerEditor } from "../components/agent/composer/ComposerEditor";
import { noteReferenceToken } from "../components/agent/composer/noteReference";
import { NoteHeaderActions } from "../components/note-editor/NoteHeaderActions";

const mocks = vi.hoisted(() => ({
  listNotes: vi.fn(),
}));

vi.mock("../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauri")>();

  return {
    ...actual,
    listNotes: mocks.listNotes,
  };
});

const now = "2026-07-03T10:00:00Z";

function installClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  mocks.listNotes.mockResolvedValue({
    items: [
      {
        id: "note-1",
        title: "Launch plan",
        preview: "",
        processingStatus: "ready",
        folderIds: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
  window.sessionStorage.clear();
});

describe("agent note entry point pending request", () => {
  it("round-trips a note reference through the new-session pending marker", () => {
    markAgentNewSessionPending(undefined, {
      noteRef: { id: "note-1", title: "Launch plan" },
    });

    expect(pendingNewSessionRequest()).toEqual({
      noteRef: { id: "note-1", title: "Launch plan" },
    });
    expect(window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY)).toBeNull();
  });

  it("defaults a missing note title while parsing the pending marker", () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        noteRef: { id: "note-1" },
      }),
    );

    expect(pendingNewSessionRequest()).toEqual({
      noteRef: { id: "note-1", title: "" },
    });
  });

  it("drops an expired note reference marker", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));

    markAgentNewSessionPending(undefined, {
      noteRef: { id: "note-1", title: "Launch plan" },
    });
    vi.advanceTimersByTime(15_001);

    expect(pendingNewSessionRequest()).toBeUndefined();
  });

  it("drops malformed note references without dropping the pending request", () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        noteRef: { id: 123, title: "Bad reference" },
      }),
    );

    expect(pendingNewSessionRequest()).toEqual({});
  });

  it("lets category seeding take precedence over note reference seeding", () => {
    markAgentNewSessionPending(undefined, {
      category: "bug",
      noteRef: { id: "note-1", title: "Launch plan" },
    });

    expect(pendingNewSessionRequest()).toEqual({ category: "bug" });
  });
});

describe("note header actions", () => {
  it("calls the Ask June handler from the note toolbar", async () => {
    const user = userEvent.setup();
    const onAskJune = vi.fn();
    render(
      createElement(NoteHeaderActions, {
        noteId: "note-1",
        noteTitle: "Launch plan",
        onAskJune,
      }),
    );

    await user.click(screen.getByRole("button", { name: "Ask June" }));

    expect(onAskJune).toHaveBeenCalledTimes(1);
  });

  it("shows a working dot while the note's chat is generating", () => {
    const { container } = render(
      createElement(NoteHeaderActions, {
        noteId: "note-1",
        noteTitle: "Launch plan",
        askJuneWorking: true,
      }),
    );

    // The button name stays clean ("Ask June"); the working state rides on a
    // data attribute + a decorative dot, not the accessible name.
    expect(screen.getByRole("button", { name: "Ask June" })).toHaveAttribute(
      "data-working",
      "true",
    );
    expect(container.querySelector(".note-header-ask-dot")).not.toBeNull();
  });

  it("copies the exact note reference token", async () => {
    const user = userEvent.setup();
    const writeText = installClipboard();
    render(createElement(NoteHeaderActions, { noteId: "note-1", noteTitle: "Launch plan" }));

    const copyButton = screen.getByRole("button", { name: "Copy note reference" });
    await user.click(copyButton);

    expect(writeText).toHaveBeenCalledWith(
      noteReferenceToken({ id: "note-1", title: "Launch plan" }),
    );
    await waitFor(() => expect(copyButton).toHaveAttribute("data-copied", "true"));
  });

  it("exports the note from the actions menu", async () => {
    const user = userEvent.setup();
    const onExportPdf = vi.fn();
    render(
      createElement(NoteHeaderActions, {
        noteId: "note-1",
        noteTitle: "Launch plan",
        onExportPdf,
      }),
    );

    await user.click(screen.getByRole("button", { name: "Note actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Export as PDF" }));

    expect(onExportPdf).toHaveBeenCalledTimes(1);
  });
});

describe("composer note reference trigger", () => {
  it("opens the note palette when a literal at sign is inserted at the caret", async () => {
    let editor: Editor | null = null;

    render(
      createElement(ComposerEditor, {
        placeholder: "Message June",
        onChange: vi.fn(),
        onSubmit: vi.fn(),
        onReady: (readyEditor: Editor) => {
          editor = readyEditor;
        },
      }),
    );

    await waitFor(() => expect(editor).not.toBeNull());
    act(() => {
      editor?.chain().focus().insertContent("@").run();
    });

    expect(await screen.findByRole("listbox", { name: "Reference a note" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Launch plan" })).toBeInTheDocument();
  });

  it("pads the trigger with a space when the caret follows text", async () => {
    // The suggestion plugin only matches "@" after whitespace or a line
    // start, so the attach-menu entry point pads it; a bare "@" after text
    // must NOT open the palette (this is the regression the padding fixes).
    let editor: Editor | null = null;

    render(
      createElement(ComposerEditor, {
        placeholder: "Message June",
        onChange: vi.fn(),
        onSubmit: vi.fn(),
        onReady: (readyEditor: Editor) => {
          editor = readyEditor;
        },
      }),
    );

    await waitFor(() => expect(editor).not.toBeNull());
    act(() => {
      editor?.chain().focus().insertContent("What were the action items?@").run();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("listbox", { name: "Reference a note" })).not.toBeInTheDocument();

    act(() => {
      editor?.chain().focus().insertContent(" @").run();
    });
    expect(await screen.findByRole("listbox", { name: "Reference a note" })).toBeInTheDocument();
  });
});
