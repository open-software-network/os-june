import type { Editor } from "@tiptap/react";
import { createRef } from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const editorMock = vi.hoisted(() => ({ current: null as Editor | null }));
const mutationMocks = vi.hoisted(() => ({
  insertReportCategory: vi.fn(),
  insertNoteReference: vi.fn(),
}));

vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  return {
    ...actual,
    EditorContent: () => null,
    useEditor: () => editorMock.current,
  };
});

vi.mock("../components/agent/composer/categoryChip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/agent/composer/categoryChip")>();
  return {
    ...actual,
    insertReportCategory: mutationMocks.insertReportCategory,
  };
});

vi.mock("../components/agent/composer/noteReference", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../components/agent/composer/noteReference")>();
  return {
    ...actual,
    insertNoteReference: mutationMocks.insertNoteReference,
  };
});

import {
  buildDoc,
  ComposerEditor,
  type ComposerEditorHandle,
} from "../components/agent/composer/ComposerEditor";

describe("composer editor lifecycle", () => {
  beforeEach(() => {
    mutationMocks.insertReportCategory.mockClear();
    mutationMocks.insertNoteReference.mockClear();
  });

  it("does not access the editor view or commands before the view mounts", () => {
    const on = vi.fn();
    const off = vi.fn();
    editorMock.current = {
      isDestroyed: true,
      on,
      off,
      get view(): never {
        throw new Error("view is not mounted");
      },
      get commands(): never {
        throw new Error("commands require a mounted view");
      },
    } as unknown as Editor;
    const ref = createRef<ComposerEditorHandle>();

    expect(() =>
      render(
        <ComposerEditor
          ref={ref}
          placeholder="Message June"
          onChange={vi.fn()}
          onSubmit={vi.fn()}
        />,
      ),
    ).not.toThrow();
    expect(on).toHaveBeenCalledWith("create", expect.any(Function));

    expect(() => {
      ref.current?.focus();
      ref.current?.clear();
      ref.current?.setContent("Restored draft");
      ref.current?.insertCategory("bug");
      ref.current?.insertNoteReference({ id: "note-1", title: "Note" });
    }).not.toThrow();
    expect(ref.current?.insertPlainText("Dictated text")).toBe(false);
    expect(ref.current?.isFocused()).toBe(false);
    expect(ref.current?.isEmpty()).toBe(true);
  });

  it("applies the latest queued content and later insertions when the view mounts", () => {
    let mounted = false;
    const mountHandlers: Array<() => void> = [];
    const setContent = vi.fn();
    const scroller = document.createElement("div");
    const editor = {
      get isDestroyed() {
        return !mounted;
      },
      on: vi.fn((event: string, handler: () => void) => {
        if (event === "mount") mountHandlers.push(handler);
      }),
      off: vi.fn(),
      get commands() {
        if (!mounted) throw new Error("commands require a mounted view");
        return { setContent };
      },
      get view() {
        if (!mounted) throw new Error("view is not mounted");
        return { dom: scroller };
      },
      state: {
        selection: { empty: true },
      },
    } as unknown as Editor;
    editorMock.current = editor;
    const ref = createRef<ComposerEditorHandle>();
    render(
      <ComposerEditor ref={ref} placeholder="Message June" onChange={vi.fn()} onSubmit={vi.fn()} />,
    );

    ref.current?.setContent("Stale draft", "bug", { focus: false });
    ref.current?.insertCategory("feedback");
    ref.current?.setContent("Restored draft", null, { focus: false });
    ref.current?.insertCategory("feature");
    ref.current?.insertNoteReference({ id: "note-1", title: "Note" });

    expect(setContent).not.toHaveBeenCalled();
    expect(mutationMocks.insertReportCategory).not.toHaveBeenCalled();
    expect(mutationMocks.insertNoteReference).not.toHaveBeenCalled();
    expect(mountHandlers).toHaveLength(1);

    act(() => {
      mounted = true;
      mountHandlers[0]();
    });

    expect(setContent).toHaveBeenCalledOnce();
    expect(setContent).toHaveBeenCalledWith(buildDoc("Restored draft", null), {
      emitUpdate: true,
    });
    expect(mutationMocks.insertReportCategory).toHaveBeenCalledOnce();
    expect(mutationMocks.insertReportCategory).toHaveBeenCalledWith(editor, "feature");
    expect(mutationMocks.insertNoteReference).toHaveBeenCalledOnce();
    expect(mutationMocks.insertNoteReference).toHaveBeenCalledWith(editor, {
      id: "note-1",
      title: "Note",
    });
  });
});
