import Mention from "@tiptap/extension-mention";
import type { Editor } from "@tiptap/react";
import { ReactNodeViewRenderer, ReactRenderer } from "@tiptap/react";
import { PluginKey, TextSelection } from "@tiptap/pm/state";
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
import { matchBuiltinComposerSlashCommands } from "../../../lib/agent-composer-slash-commands";

/** Node name for the inline category chip. Distinct from the generic
 * "mention" node so the composer's chip styling never bleeds into (or
 * inherits from) any other mention surface. */
export const CATEGORY_CHIP_NODE = "reportCategory";

/** The single character that opens the category palette. "/" reads as a
 * command; "#" would read as a tag and is intentionally not used. */
const TRIGGER_CHAR = "/";
const SLASH_MENU_SKILL_LIMIT = Number.MAX_SAFE_INTEGER;
const CATEGORY_SUGGESTION_PLUGIN_KEY = new PluginKey("agentCategorySuggestion");
export const CATEGORY_SKILLS_CHANGED_EVENT = "agent-category-skills-changed";

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
      pluginKey: CATEGORY_SUGGESTION_PLUGIN_KEY,
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
        if (item.kind === "builtin") {
          insertSlashCommandText(editor, item.command.insertText, range);
          return;
        }
        insertSlashCommandText(editor, `/${item.skill.name} `, range);
      },
      render: () => {
        let renderer: ReactRenderer<
          CategorySuggestionListHandle,
          CategorySuggestionListProps
        > | null = null;
        let host: HTMLDivElement | null = null;
        let latestProps: {
          command: CategorySuggestionListProps["command"];
          editor: Editor;
          query: string;
          clientRect?: (() => DOMRect | null) | null;
        } | null = null;
        let ownerDocument: Document | null = null;

        function position(props: {
          clientRect?: (() => DOMRect | null) | null;
          editor: Editor;
        }) {
          if (!host || !props.clientRect) return;
          const rect = props.clientRect();
          if (!rect) return;
          const gap = 6;
          const pad = 8;
          const composerBox = props.editor.view.dom.closest<HTMLElement>(
            ".agent-composer-box",
          );
          const composerRect = composerBox?.getBoundingClientRect();
          const width = Math.min(
            composerRect?.width ?? host.getBoundingClientRect().width,
            window.innerWidth - pad * 2,
          );
          host.style.setProperty("--agent-category-menu-width", `${width}px`);
          const maxLeft = window.innerWidth - width - pad;
          const left = Math.min(
            Math.max(composerRect?.left ?? rect.left, pad),
            Math.max(pad, maxLeft),
          );
          const anchorRect = composerRect ?? rect;
          const belowTop = anchorRect.bottom + gap;
          const belowSpace = window.innerHeight - belowTop - pad;
          const aboveSpace = anchorRect.top - gap - pad;
          const hostRect = host.getBoundingClientRect();
          const fitsBelow = belowSpace >= hostRect.height;
          const placeBelow = fitsBelow || belowSpace >= aboveSpace;
          const maxHeight = Math.max(
            88,
            Math.min(placeBelow ? belowSpace : aboveSpace, 280),
          );
          const top = placeBelow
            ? belowTop
            : Math.max(
                anchorRect.top - Math.min(hostRect.height, maxHeight) - gap,
                pad,
              );

          host.style.setProperty(
            "--agent-category-menu-max-height",
            `${maxHeight}px`,
          );
          host.style.bottom = "";
          host.style.top = `${Math.max(top, pad)}px`;
          host.style.left = `${left}px`;
        }

        function updateLatestProps(props: {
          command: unknown;
          editor: Editor;
          query: string;
          clientRect?: (() => DOMRect | null) | null;
        }) {
          latestProps = {
            ...props,
            command: props.command as CategorySuggestionListProps["command"],
          };
        }

        function refreshItems() {
          if (!renderer || !latestProps) return;
          renderer.updateProps({
            items: composerSlashCommandItems(
              latestProps.query,
              options.skills?.(),
            ),
            command: latestProps.command,
          });
          position(latestProps);
        }

        function dismissFromPointerDown(event: PointerEvent) {
          const target = event.target;
          if (!(target instanceof Node) || host?.contains(target)) return;
          const view = latestProps?.editor.view;
          if (!view) return;
          view.dispatch(
            view.state.tr.setMeta(CATEGORY_SUGGESTION_PLUGIN_KEY, {
              exit: true,
            }),
          );
        }

        function cleanupPopover() {
          renderer?.destroy();
          host?.removeEventListener(
            CATEGORY_SKILLS_CHANGED_EVENT,
            refreshItems,
          );
          ownerDocument?.removeEventListener(
            "pointerdown",
            dismissFromPointerDown,
            true,
          );
          host?.remove();
          renderer = null;
          host = null;
          latestProps = null;
          ownerDocument = null;
        }

        return {
          onStart(props) {
            updateLatestProps(props);
            renderer = new ReactRenderer(CategorySuggestionList, {
              props: { items: props.items, command: props.command },
              editor: props.editor,
            });
            host = document.createElement("div");
            host.className = "agent-category-menu-host";
            host.addEventListener(CATEGORY_SKILLS_CHANGED_EVENT, refreshItems);
            host.appendChild(renderer.element);
            document.body.appendChild(host);
            ownerDocument = props.editor.view.dom.ownerDocument;
            ownerDocument.addEventListener(
              "pointerdown",
              dismissFromPointerDown,
              true,
            );
            position(props);
          },
          onUpdate(props) {
            updateLatestProps(props);
            renderer?.updateProps({
              items: props.items,
              command: props.command,
            });
            position(props);
          },
          onKeyDown(props) {
            if (props.event.key === "Escape") {
              cleanupPopover();
              return true;
            }
            return renderer?.ref?.onKeyDown(props.event) ?? false;
          },
          onExit() {
            cleanupPopover();
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
  const builtins = matchBuiltinComposerSlashCommands(query).map((command) => ({
    kind: "builtin" as const,
    command,
  }));
  const categories = matchReportCategories(query).map((category) => ({
    kind: "category" as const,
    category,
  }));
  return [
    ...builtins,
    ...categories,
    ...matchSkillSlashSuggestions(query, skills, SLASH_MENU_SKILL_LIMIT).map(
      (skill) => ({
        kind: "skill" as const,
        skill,
      }),
    ),
  ];
}

function insertSlashCommandText(
  editor: Editor,
  text: string,
  range: { from: number; to: number },
) {
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
