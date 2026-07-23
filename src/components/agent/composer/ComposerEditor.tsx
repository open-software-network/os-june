import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import {
  CATEGORY_CHIP_NODE,
  CATEGORY_SKILLS_CHANGED_EVENT,
  categoryFromDoc,
  createCategoryChip,
  insertReportCategory,
} from "./categoryChip";
import {
  NOTE_REFERENCE_NODE,
  createNoteReference,
  insertNoteReference,
  noteReferenceToken,
  type NoteReferenceInput,
} from "./noteReference";
import type { ReportCategory } from "./reportCategory";
import type { HermesSkillInfo } from "../../../lib/tauri";
import type { BuiltinComposerSlashCommandName } from "../../../lib/agent-composer-slash-commands";

export type ComposerEditorHandle = {
  focus: () => void;
  clear: () => void;
  /** Replaces the whole document with plain text plus an optional leading
   * category chip. Used to prefill (hero shortcuts, HUD replies) and to restore
   * the composer after a failed send. With `selectPlaceholder`, the first
   * `<placeholder>` token's brackets are stripped and the bare phrase left
   * selected so the user can overtype it in place. */
  setContent: (
    text: string,
    category?: ReportCategory | null,
    options?: { selectPlaceholder?: boolean; focus?: boolean },
  ) => void;
  /** Inserts or swaps the legacy message category tag at the caret. */
  insertCategory: (category: ReportCategory) => void;
  /** Inserts a note reference chip at the caret. Multiple references can
   * coexist because they serialize into the prompt text. */
  insertNoteReference: (ref: NoteReferenceInput) => void;
  isEmpty: () => boolean;
};

type ComposerEditorProps = {
  placeholder: string;
  skills?: HermesSkillInfo[] | null;
  onChange: (text: string, category: ReportCategory | null) => void;
  onSubmit: () => void;
  /** Returns true when the host handles the selected command as an immediate
   * action instead of inserting its slash text into the draft. */
  onBuiltinSlashCommand?: (name: BuiltinComposerSlashCommandName) => boolean;
  /** Builtin commands the host surface does not offer in the slash menu. */
  hiddenBuiltinSlashCommands?: readonly BuiltinComposerSlashCommandName[];
  /** Hands the live editor up to the parent (e.g. so the composer box can read
   * its DOM element for layout). */
  onReady?: (editor: Editor) => void;
};

/** Serializes the doc to the plain string sent to June: paragraph and
 * hard-break boundaries become newlines, the category chip contributes
 * nothing, and note reference atoms emit the stable token Hermes resolves via
 * June's note context tool. */
export function serializePlainText(doc: ProseMirrorNode): string {
  return doc.textBetween(0, doc.content.size, "\n", (leaf) => {
    if (leaf.type.name === "hardBreak") return "\n";
    if (leaf.type.name === NOTE_REFERENCE_NODE) {
      return noteReferenceToken({
        id: typeof leaf.attrs.noteId === "string" ? leaf.attrs.noteId : "",
        title: typeof leaf.attrs.title === "string" ? leaf.attrs.title : "",
      });
    }
    return "";
  });
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

/** Prepares a prefilled single-paragraph prompt for staging: strips the angle
 * brackets off the first `<placeholder>` token (authoring syntax that should
 * never reach the user's eyes) and maps the bare phrase to its ProseMirror
 * selection range so a hero shortcut can highlight it for overtyping. The
 * paragraph's opening boundary occupies position 0, so a string index `i`
 * maps to document position `i + 1`. Null when there is no placeholder. */
export function stripPlaceholder(text: string): { text: string; from: number; to: number } | null {
  const start = text.indexOf("<");
  const end = text.indexOf(">");
  if (start < 0 || end <= start) return null;
  return {
    text: text.slice(0, start) + text.slice(start + 1, end) + text.slice(end + 1),
    from: start + 1,
    to: end,
  };
}

/** Splits a line into text nodes and note-reference chips. Drafts persist as
 * the serialized plain string, so a restored draft carries reference tokens
 * as text; rebuilding the chip here keeps the pill UX across restores. The
 * round-trip is lossless because serializePlainText re-emits the token. */
function inlineContent(line: string) {
  const nodes: Array<Record<string, unknown>> = [];
  const tokenPattern = /@note:([\w-]+)(?: \("([^"]*)"\))?/g;
  let consumed = 0;
  for (const match of line.matchAll(tokenPattern)) {
    if (match.index > consumed) {
      nodes.push({ type: "text", text: line.slice(consumed, match.index) });
    }
    nodes.push({
      type: NOTE_REFERENCE_NODE,
      attrs: { noteId: match[1], title: match[2] ?? "" },
    });
    consumed = match.index + match[0].length;
  }
  if (consumed < line.length) {
    nodes.push({ type: "text", text: line.slice(consumed) });
  }
  return nodes;
}

export function buildDoc(
  text: string,
  category?: ReportCategory | null,
  options?: { rehydrateNoteTokens?: boolean },
) {
  // Placeholder-staged prefills skip rehydration: stripPlaceholder maps raw
  // string indices to doc positions, which only holds while every character
  // stays a size-1 text position — a chip atom would shift the selection.
  const rehydrate = options?.rehydrateNoteTokens !== false;
  const paragraphs = text.split("\n").map((line) => ({
    type: "paragraph",
    // A text node may not be empty, so a blank line is an empty paragraph.
    content: rehydrate ? inlineContent(line) : line ? [{ type: "text", text: line }] : [],
  }));
  if (paragraphs.length === 0) paragraphs.push({ type: "paragraph", content: [] });
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

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  (
    {
      placeholder,
      skills,
      onChange,
      onSubmit,
      onBuiltinSlashCommand,
      hiddenBuiltinSlashCommands,
      onReady,
    },
    ref,
  ) => {
    const frameRef = useRef<HTMLDivElement | null>(null);
    const skillsRef = useRef(skills);
    // Latest callbacks behind refs so the editor (created once) never closes
    // over a stale handler.
    const onChangeRef = useRef(onChange);
    const onSubmitRef = useRef(onSubmit);
    const onBuiltinSlashCommandRef = useRef(onBuiltinSlashCommand);
    const hiddenBuiltinSlashCommandsRef = useRef(hiddenBuiltinSlashCommands);
    const onReadyRef = useRef(onReady);
    useEffect(() => {
      onChangeRef.current = onChange;
      onSubmitRef.current = onSubmit;
      onBuiltinSlashCommandRef.current = onBuiltinSlashCommand;
      hiddenBuiltinSlashCommandsRef.current = hiddenBuiltinSlashCommands;
      onReadyRef.current = onReady;
      skillsRef.current = skills;
    }, [onChange, onSubmit, onBuiltinSlashCommand, hiddenBuiltinSlashCommands, onReady, skills]);

    useEffect(() => {
      document.querySelectorAll(".agent-category-menu-host").forEach((host) => {
        host.dispatchEvent(new CustomEvent(CATEGORY_SKILLS_CHANGED_EVENT));
      });
    }, [skills]);

    function updateScrollFades(nextEditor: Editor | null) {
      const frame = frameRef.current;
      if (!frame || !nextEditor || nextEditor.isDestroyed) return;
      const scroller = nextEditor.view.dom;
      // A range selection paints a full-width highlight, and the edge fades
      // shave it — which reads as the selection being clipped, not as content
      // melting out of view. Drop the fades until the selection collapses.
      if (!nextEditor.state.selection.empty) {
        delete frame.dataset.fadeTop;
        delete frame.dataset.fadeBottom;
        return;
      }
      const overflow = scroller.scrollHeight - scroller.clientHeight > 1;
      const atTop = scroller.scrollTop <= 1;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
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
        createCategoryChip({
          skills: () => skillsRef.current,
          onBuiltinCommand: (name) => onBuiltinSlashCommandRef.current?.(name) ?? false,
          hiddenBuiltinCommands: () => hiddenBuiltinSlashCommandsRef.current,
        }),
        createNoteReference(),
      ],
      editorProps: {
        attributes: {
          class: "agent-composer-editor",
          role: "textbox",
          "aria-label": "Message June",
          "aria-multiline": "true",
        },
        handleScrollToSelection: (view) => {
          // ProseMirror's own scrollIntoView walks every scrollable ancestor,
          // and the composer is a DOM child of the chat scroller
          // (.agent-scroll) — so growing the draft (Shift+Enter, paste)
          // dragged the conversation behind the fixed box. Scroll only the
          // editor's own scroller and stop the walk.
          const scroller = view.dom;
          const caret = view.coordsAtPos(view.state.selection.head);
          const box = scroller.getBoundingClientRect();
          const margin = 6; // the editor's own vertical padding
          if (caret.top < box.top + margin) {
            scroller.scrollTop -= box.top + margin - caret.top;
          } else if (caret.bottom > box.bottom - margin) {
            scroller.scrollTop += caret.bottom - (box.bottom - margin);
          }
          return true;
        },
        handleKeyDown: (_view, event) => {
          if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
            return false;
          }
          // Suggestion palettes own Enter while open (they commit the
          // highlighted row); only a closed palette submits the message.
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
      onSelectionUpdate: ({ editor }) => {
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
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
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
          const staged = options?.selectPlaceholder && !category ? stripPlaceholder(text) : null;
          editor.commands.setContent(
            buildDoc(staged?.text ?? text, category, { rehydrateNoteTokens: !staged }),
            {
              emitUpdate: true,
            },
          );
          // A hero shortcut authors a "<placeholder>" token; the brackets are
          // stripped before the text hits the document and the bare phrase left
          // selected (rather than parking the caret at the end) so typing
          // overtypes it in place.
          const range = staged ? { from: staged.from, to: staged.to } : null;
          const shouldFocus = options?.focus !== false;
          if (range) {
            editor.commands.setTextSelection(range);
            if (shouldFocus) editor.view.focus();
          } else if (shouldFocus) {
            focusEnd(editor);
          }
        },
        insertCategory: (category) => {
          if (editor) insertReportCategory(editor, category);
        },
        insertNoteReference: (noteReference) => {
          if (editor) insertNoteReference(editor, noteReference);
        },
        isEmpty: () => editor?.isEmpty ?? true,
      }),
      [editor],
    );

    return (
      <div ref={frameRef} className="agent-composer-editor-root scroll-fade">
        <EditorContent editor={editor} />
      </div>
    );
  },
);
ComposerEditor.displayName = "ComposerEditor";
