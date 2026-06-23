import Mention from "@tiptap/extension-mention";
import type { Editor } from "@tiptap/react";
import { ReactNodeViewRenderer, ReactRenderer } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";

import { CategoryChipView } from "./CategoryChipView";
import {
  CategorySuggestionList,
  type ComposerSlashCommandItem,
  type CategorySuggestionListHandle,
  type CategorySuggestionListProps,
} from "./CategorySuggestionList";
import {
  matchReportCategories,
  reportCategoryDef,
  type ReportCategory,
} from "./reportCategory";
import type { HermesSkillInfo } from "../../../lib/tauri";
import { matchSkillSlashSuggestions } from "../../../lib/skill-slash-commands";

/** Node name for the inline category chip. Distinct from the generic
 * "mention" node so the composer's chip styling never bleeds into (or
 * inherits from) any other mention surface. */
export const CATEGORY_CHIP_NODE = "reportCategory";

/** The single character that opens the category palette. "/" reads as a
 * command; "#" would read as a tag and is intentionally not used. */
const TRIGGER_CHAR = "/";

/** Reads the active category from a doc by scanning for the chip node. The
 * single-chip invariant (enforced on insert) means the first hit is the
 * answer. */
export function categoryFromDoc(doc: ProseMirrorNode): ReportCategory | null {
  let category: ReportCategory | null = null;
  doc.descendants((node) => {
    if (category) return false;
    if (node.type.name === CATEGORY_CHIP_NODE) {
      const value = node.attrs.category;
      if (typeof value === "string") category = value as ReportCategory;
      return false;
    }
    return true;
  });
  return category;
}

/** Removes every existing chip from `tr`, deleting from the end so the earlier
 * positions stay valid as the doc shrinks. Also swallows the single separator
 * space that follows a chip (the one insertCategoryCommand adds), so swapping
 * one chip for another doesn't strand a leading space. Mutates `tr` in place. */
function clearChips(tr: Transaction, doc: ProseMirrorNode) {
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === CATEGORY_CHIP_NODE) positions.push(pos);
  });
  for (const pos of positions.sort((a, b) => b - a)) {
    const afterChip = pos + 1;
    const followedBySpace =
      afterChip < doc.content.size &&
      doc.textBetween(afterChip, afterChip + 1) === " ";
    tr.delete(pos, followedBySpace ? afterChip + 1 : afterChip);
  }
}

/** A tiptap command that swaps in `category` as the message's single tag:
 * drops any existing chip, then inserts the new chip (plus a trailing space so
 * the caret lands on editable text) at `range` when one is given (the "/query"
 * span) or at the selection otherwise (the "+" menu). */
function insertCategoryCommand(
  category: ReportCategory,
  range?: { from: number; to: number },
) {
  return ({
    tr,
    state,
    dispatch,
  }: {
    tr: Transaction;
    state: EditorState;
    dispatch?: (tr: Transaction) => void;
  }) => {
    const chip = state.schema.nodes[CATEGORY_CHIP_NODE]?.create({ category });
    if (!chip) return false;
    if (!dispatch) return true;

    clearChips(tr, state.doc);
    const from = tr.mapping.map(range ? range.from : state.selection.from);
    const to = tr.mapping.map(range ? range.to : state.selection.to);
    tr.replaceWith(from, to, chip);

    // Land the caret on text after the chip, adding a space when the chip
    // would otherwise butt against the next character (or the doc end).
    const afterChip = from + chip.nodeSize;
    const $after = tr.doc.resolve(afterChip);
    const next = $after.nodeAfter;
    if (!next || !next.isText || !next.text?.startsWith(" ")) {
      tr.insert(afterChip, state.schema.text(" "));
    }
    tr.setSelection(TextSelection.create(tr.doc, afterChip + 1));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Inserts (or swaps) the category chip at the current selection. Used by the
 * "+" popover and by the sidebar/settings "Report an issue" entry points. */
export function insertReportCategory(editor: Editor, category: ReportCategory) {
  editor.chain().focus().command(insertCategoryCommand(category)).run();
}

/** The inline atom chip ("Bug report" / "Feedback" / "Feature request"). Built
 * on Mention so it inherits the atom-node behaviour ProseMirror gives for
 * free: one backspace removes it, the caret can't land inside it, and text
 * wraps around it. */
const CategoryChipBase = Mention.extend({
  name: CATEGORY_CHIP_NODE,

  addAttributes() {
    return {
      category: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-category"),
        renderHTML: (attributes) =>
          attributes.category
            ? { "data-category": attributes.category as string }
            : {},
      },
    };
  },

  // The chip is a tag, not prose — it contributes no text to the prompt
  // string. The category travels separately (see categoryFromDoc).
  renderText() {
    return "";
  },

  addNodeView() {
    return ReactNodeViewRenderer(CategoryChipView);
  },
});

export type CategoryChipOptions = {
  skills?: () => HermesSkillInfo[] | null | undefined;
};

export function createCategoryChip(options: CategoryChipOptions = {}) {
  return CategoryChipBase.configure({
    deleteTriggerWithBackspace: true,
    renderHTML({ node }) {
      const def = reportCategoryDef(node.attrs.category as string);
      return [
        "span",
        {
          class: "agent-category-chip",
          "data-category": (node.attrs.category as string) ?? "",
        },
        def?.label ?? "",
      ];
    },
    suggestion: {
      char: TRIGGER_CHAR,
      // A leading "/" only — typing a path like "src/foo" mid-word must not pop
      // the palette.
      allowSpaces: false,
      items: ({ query }) =>
        composerSlashCommandItems(query, options.skills?.()),
      command: ({ editor, range, props }) => {
        const item = props as unknown as ComposerSlashCommandItem;
        if (item.kind === "category") {
          const { key: category } = item.category;
          editor
            .chain()
            .focus()
            .command(insertCategoryCommand(category, range))
            .run();
          return;
        }
        insertSkillSlashCommand(editor, item.skill.name, range);
      },
      render: () => {
        let renderer: ReactRenderer<
          CategorySuggestionListHandle,
          CategorySuggestionListProps
        > | null = null;
        let host: HTMLDivElement | null = null;

        function position(props: {
          clientRect?: (() => DOMRect | null) | null;
          editor: Editor;
        }) {
          if (!host || !props.clientRect) return;
          const rect = props.clientRect();
          if (!rect) return;
          const gap = 6;
          const pad = 8;
          const hostRect = host.getBoundingClientRect();
          const maxLeft = window.innerWidth - hostRect.width - pad;
          const left = Math.min(
            Math.max(rect.left, pad),
            Math.max(pad, maxLeft),
          );
          const composerBox = props.editor.view.dom.closest<HTMLElement>(
            ".agent-composer-box",
          );
          if (composerBox) {
            const composerRect = composerBox.getBoundingClientRect();
            host.style.top = "";
            host.style.bottom = `${Math.max(
              window.innerHeight - composerRect.top + gap,
              pad,
            )}px`;
            host.style.left = `${left}px`;
            return;
          }
          // Prefer opening above the caret (the composer sits low on screen),
          // dropping below only when there's no room up top.
          const aboveTop = rect.top - hostRect.height - gap;
          const belowTop = rect.bottom + gap;
          const fitsAbove = aboveTop >= pad;
          const top = fitsAbove ? aboveTop : belowTop;
          host.style.bottom = "";
          host.style.top = `${Math.max(top, pad)}px`;
          host.style.left = `${left}px`;
        }

        return {
          onStart(props) {
            renderer = new ReactRenderer(CategorySuggestionList, {
              props: { items: props.items, command: props.command },
              editor: props.editor,
            });
            host = document.createElement("div");
            host.className = "agent-category-menu-host";
            host.appendChild(renderer.element);
            document.body.appendChild(host);
            position(props);
          },
          onUpdate(props) {
            renderer?.updateProps({
              items: props.items,
              command: props.command,
            });
            position(props);
          },
          onKeyDown(props) {
            if (props.event.key === "Escape") {
              renderer?.destroy();
              host?.remove();
              renderer = null;
              host = null;
              return true;
            }
            return renderer?.ref?.onKeyDown(props.event) ?? false;
          },
          onExit() {
            renderer?.destroy();
            host?.remove();
            renderer = null;
            host = null;
          },
        };
      },
    },
  });
}

export const CategoryChip = createCategoryChip();

function composerSlashCommandItems(
  query: string,
  skills: HermesSkillInfo[] | null | undefined,
): ComposerSlashCommandItem[] {
  return [
    ...matchReportCategories(query).map((category) => ({
      kind: "category" as const,
      category,
    })),
    ...matchSkillSlashSuggestions(query, skills).map((skill) => ({
      kind: "skill" as const,
      skill,
    })),
  ];
}

function insertSkillSlashCommand(
  editor: Editor,
  skillName: string,
  range: { from: number; to: number },
) {
  const text = `/${skillName} `;
  editor
    .chain()
    .focus()
    .command(({ tr, state, dispatch }) => {
      if (!dispatch) return true;
      const from = tr.mapping.map(range.from);
      const to = tr.mapping.map(range.to);
      tr.replaceWith(from, to, state.schema.text(text));
      tr.setSelection(TextSelection.create(tr.doc, from + text.length));
      dispatch(tr.scrollIntoView());
      return true;
    })
    .run();
}
