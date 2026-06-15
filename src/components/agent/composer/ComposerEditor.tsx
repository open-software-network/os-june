import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import {
  CATEGORY_CHIP_NODE,
  CategoryChip,
  categoryFromDoc,
  insertReportCategory,
} from "./categoryChip";
import type { ReportCategory } from "./reportCategory";

export type ComposerEditorHandle = {
  focus: () => void;
  clear: () => void;
  /** Replaces the whole document with plain text plus an optional leading
   * category chip. Used to prefill (run shortcuts, HUD replies) and to restore
   * the composer after a failed send. With `selectPlaceholder`, the first
   * `<placeholder>` token is selected so the user can overtype it in place. */
  setContent: (
    text: string,
    category?: ReportCategory | null,
    options?: { selectPlaceholder?: boolean },
  ) => void;
  /** Inserts or swaps the message's single category tag at the caret. */
  insertCategory: (category: ReportCategory) => void;
  isEmpty: () => boolean;
};

type ComposerEditorProps = {
  placeholder: string;
  onChange: (text: string, category: ReportCategory | null) => void;
  onSubmit: () => void;
  /** Hands the live editor up to the parent (e.g. so the composer box can read
   * its DOM element for layout). */
  onReady?: (editor: Editor) => void;
};

/** Serializes the doc to the plain string sent to June: paragraph and
 * hard-break boundaries become newlines, and the category chip (a leaf atom)
 * contributes nothing — its meaning rides along as the category, not as text. */
export function serializePlainText(doc: ProseMirrorNode): string {
  return doc.textBetween(0, doc.content.size, "\n", (leaf) =>
    leaf.type.name === "hardBreak" ? "\n" : "",
  );
}

/** Focuses the editor with the caret at the end, synchronously. tiptap's
 * `focus` command defers the actual `view.focus()` to a requestAnimationFrame
 * (for scroll handling); that deferral can land after the user has moved on
 * and steal focus back from, say, a menu they just opened. Focusing the view
 * directly keeps it immediate. */
function focusEnd(editor: Editor | null) {
  if (!editor || editor.isDestroyed) return;
  editor.commands.setTextSelection(editor.state.doc.content.size);
  editor.view.focus();
}

/** Maps the first `<placeholder>` token in a prefilled single-paragraph prompt
 * to its ProseMirror selection range, so a run shortcut can highlight it. The
 * paragraph's opening boundary occupies position 0, so a string index `i` maps
 * to document position `i + 1`; the range spans `<` through `>` inclusive. */
export function placeholderSelection(
  text: string,
): { from: number; to: number } | null {
  const start = text.indexOf("<");
  const end = text.indexOf(">");
  if (start < 0 || end <= start) return null;
  return { from: start + 1, to: end + 2 };
}

function buildDoc(text: string, category?: ReportCategory | null) {
  const paragraphs = text.split("\n").map((line) => ({
    type: "paragraph",
    // A text node may not be empty, so a blank line is an empty paragraph.
    content: line ? [{ type: "text", text: line }] : [],
  }));
  if (paragraphs.length === 0)
    paragraphs.push({ type: "paragraph", content: [] });
  if (category) {
    const first = paragraphs[0];
    first.content = [
      { type: CATEGORY_CHIP_NODE, attrs: { category } } as never,
      { type: "text", text: " " },
      ...first.content,
    ];
  }
  return { type: "doc", content: paragraphs };
}

export const ComposerEditor = forwardRef<
  ComposerEditorHandle,
  ComposerEditorProps
>(({ placeholder, onChange, onSubmit, onReady }, ref) => {
  const frameRef = useRef<HTMLDivElement | null>(null);
  // Latest callbacks behind refs so the editor (created once) never closes
  // over a stale handler.
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onChangeRef.current = onChange;
    onSubmitRef.current = onSubmit;
    onReadyRef.current = onReady;
  }, [onChange, onSubmit, onReady]);

  function updateScrollFades(nextEditor: Editor | null) {
    const frame = frameRef.current;
    if (!frame || !nextEditor || nextEditor.isDestroyed) return;
    const scroller = nextEditor.view.dom;
    const overflow = scroller.scrollHeight - scroller.clientHeight > 1;
    const atTop = scroller.scrollTop <= 1;
    const atBottom =
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
    if (overflow && !atTop) {
      frame.dataset.fadeTop = "true";
    } else {
      delete frame.dataset.fadeTop;
    }
    if (overflow && !atBottom) {
      frame.dataset.fadeBottom = "true";
    } else {
      delete frame.dataset.fadeBottom;
    }
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Truly-plain composer: no block structure or inline marks, just text,
        // soft line breaks, undo/redo, and the gap cursor (which makes landing
        // beside the atom chip feel right). Everything else is off.
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bold: false,
        italic: false,
        strike: false,
        code: false,
        underline: false,
        link: false,
        trailingNode: false,
      }),
      Placeholder.configure({ placeholder }),
      CategoryChip,
    ],
    editorProps: {
      attributes: {
        class: "agent-composer-editor",
        role: "textbox",
        "aria-label": "Message June",
        "aria-multiline": "true",
      },
      handleKeyDown: (_view, event) => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
          return false;
        }
        // The "/" palette owns Enter while it's open (it commits the
        // highlighted category); only a closed palette submits the message.
        if (document.querySelector(".agent-category-menu-host")) return false;
        event.preventDefault();
        onSubmitRef.current();
        return true;
      },
    },
    onCreate: ({ editor }) => {
      queueMicrotask(() => {
        updateScrollFades(editor);
        if (!editor.isDestroyed) onReadyRef.current?.(editor);
      });
    },
    onUpdate: ({ editor }) => {
      onChangeRef.current(
        serializePlainText(editor.state.doc),
        categoryFromDoc(editor.state.doc),
      );
      requestAnimationFrame(() => updateScrollFades(editor));
    },
  });

  useEffect(() => {
    if (!editor) return;
    const scroller = editor.view.dom;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => updateScrollFades(editor));
    };
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(scroller);
    schedule();
    return () => {
      window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [editor]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => focusEnd(editor),
      clear: () => editor?.commands.clearContent(true),
      setContent: (text, category, options) => {
        if (!editor) return;
        editor.commands.setContent(buildDoc(text, category), {
          emitUpdate: true,
        });
        // A run shortcut prefills a "<placeholder>" token; select it (rather
        // than parking the caret at the end) so typing overtypes it in place.
        const range =
          options?.selectPlaceholder && !category
            ? placeholderSelection(text)
            : null;
        if (range) {
          editor.commands.setTextSelection(range);
          editor.view.focus();
        } else {
          focusEnd(editor);
        }
      },
      insertCategory: (category) => {
        if (editor) insertReportCategory(editor, category);
      },
      isEmpty: () => editor?.isEmpty ?? true,
    }),
    [editor],
  );

  return (
    <div ref={frameRef} className="agent-composer-editor-root">
      <EditorContent editor={editor} />
    </div>
  );
});
ComposerEditor.displayName = "ComposerEditor";
