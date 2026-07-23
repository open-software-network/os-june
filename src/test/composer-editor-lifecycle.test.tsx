import type { Editor } from "@tiptap/react";
import { createRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const editorMock = vi.hoisted(() => ({ current: null as Editor | null }));

vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  return {
    ...actual,
    EditorContent: () => null,
    useEditor: () => editorMock.current,
  };
});

import {
  ComposerEditor,
  type ComposerEditorHandle,
} from "../components/agent/composer/ComposerEditor";

describe("composer editor lifecycle", () => {
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
});
