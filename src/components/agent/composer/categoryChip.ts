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
import { reportCategoryDef, type ReportCategory } from "./reportCategory";
import type { HermesSkillInfo } from "../../../lib/tauri";
import { matchSkillSlashSuggestions } from "../../../lib/skill-slash-commands";
import {
  matchBuiltinComposerSlashCommands,
  type BuiltinComposerSlashCommandName,
} from "../../../lib/agent-composer-slash-commands";

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

/** Reads the active category from the first paragraph's inline children.
 * Category drafts are built with a leading chip, but a pointer can still place
 * the caret before that atom. Scanning sibling nodes preserves that case
 * without descending through every block or walking any text characters. */
export function categoryFromDoc(doc: ProseMirrorNode): ReportCategory | null {
  const firstBlock = doc.firstChild;
  if (!firstBlock) return null;
  for (let index = 0; index < firstBlock.childCount; index += 1) {
    const inlineNode = firstBlock.child(index);
    if (inlineNode.type.name !== CATEGORY_CHIP_NODE) continue;
    const value = inlineNode.attrs.category;
    return typeof value === "string" ? (value as ReportCategory) : null;
  }
  return null;
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
      afterChip < doc.content.size && doc.textBetween(afterChip, afterChip + 1) === " ";
    tr.delete(pos, followedBySpace ? afterChip + 1 : afterChip);
  }
}

/** A tiptap command that swaps in `category` as the message's single tag:
 * drops any existing chip, then inserts the new chip (plus a trailing space so
 * the caret lands on editable text) at `range` when one is given (the "/query"
 * span) or at the selection otherwise (the "+" menu). */
function insertCategoryCommand(category: ReportCategory, range?: { from: number; to: number }) {
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

/** Inserts (or swaps) the category chip at the start of the first paragraph.
 * Kept for restored older drafts and focused tests; new report entry points
 * use the direct-submit popover instead. */
export function insertReportCategory(editor: Editor, category: ReportCategory) {
  editor
    .chain()
    .focus()
    .command(insertCategoryCommand(category, { from: 1, to: 1 }))
    .run();
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
          attributes.category ? { "data-category": attributes.category as string } : {},
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
  onBuiltinCommand?: (name: BuiltinComposerSlashCommandName) => boolean;
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
      items: ({ query }) => composerSlashCommandItems(query, options.skills?.()),
      command: ({ editor, range, props }) => {
        const item = props as unknown as ComposerSlashCommandItem;
        if (item.kind === "builtin") {
          if (options.onBuiltinCommand?.(item.command.name)) {
            editor.chain().focus().deleteRange(range).run();
            return;
          }
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
        let ownerWindow: Window | null = null;

        function position(props: { clientRect?: (() => DOMRect | null) | null; editor: Editor }) {
          if (!host || !props.clientRect) return;
          const rect = props.clientRect();
          if (!rect) return;
          const viewport = props.editor.view.dom.ownerDocument.defaultView ?? window;
          const gap = 6;
          const pad = 8;
          const composerBox = props.editor.view.dom.closest<HTMLElement>(".agent-composer-box");
          const composerRect = composerBox?.getBoundingClientRect();
          const width = Math.min(
            composerRect?.width ?? host.getBoundingClientRect().width,
            viewport.innerWidth - pad * 2,
          );
          host.style.setProperty("--agent-category-menu-width", `${width}px`);
          const maxLeft = viewport.innerWidth - width - pad;
          const left = Math.min(
            Math.max(composerRect?.left ?? rect.left, pad),
            Math.max(pad, maxLeft),
          );
          const anchorRect = composerRect ?? rect;
          const belowTop = anchorRect.bottom + gap;
          const belowSpace = viewport.innerHeight - belowTop - pad;
          const aboveSpace = anchorRect.top - gap - pad;
          const hostRect = host.getBoundingClientRect();
          const hasMeasuredHeight = hostRect.height > 0;
          const fitsBelow = hasMeasuredHeight && belowSpace >= hostRect.height;
          const fitsAbove = hasMeasuredHeight && aboveSpace >= hostRect.height;
          const placeBelow = fitsBelow || (!fitsAbove && belowSpace >= aboveSpace);
          const maxHeight = Math.max(0, Math.min(placeBelow ? belowSpace : aboveSpace, 280));

          host.style.setProperty("--agent-category-menu-max-height", `${maxHeight}px`);
          if (placeBelow) {
            host.style.bottom = "";
            host.style.top = `${Math.max(belowTop, pad)}px`;
          } else {
            // Anchor the menu's composer-facing edge instead of deriving its
            // top from a height that can be stale while async skills render.
            // The portal then grows upward and remains inside short webviews.
            host.style.top = "";
            host.style.bottom = `${Math.max(viewport.innerHeight - anchorRect.top + gap, pad)}px`;
          }
          host.style.left = `${left}px`;
        }

        function positionLatest() {
          if (latestProps) position(latestProps);
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
            items: composerSlashCommandItems(latestProps.query, options.skills?.()),
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
          host?.removeEventListener(CATEGORY_SKILLS_CHANGED_EVENT, refreshItems);
          ownerDocument?.removeEventListener("pointerdown", dismissFromPointerDown, true);
          ownerWindow?.removeEventListener("resize", positionLatest);
          ownerWindow?.visualViewport?.removeEventListener("resize", positionLatest);
          host?.remove();
          renderer = null;
          host = null;
          latestProps = null;
          ownerDocument = null;
          ownerWindow = null;
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
            ownerWindow = ownerDocument.defaultView;
            ownerDocument.addEventListener("pointerdown", dismissFromPointerDown, true);
            ownerWindow?.addEventListener("resize", positionLatest);
            ownerWindow?.visualViewport?.addEventListener("resize", positionLatest);
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
  return [
    ...builtins,
    ...matchSkillSlashSuggestions(query, skills, SLASH_MENU_SKILL_LIMIT).map((skill) => ({
      kind: "skill" as const,
      skill,
    })),
  ];
}

function insertSlashCommandText(editor: Editor, text: string, range: { from: number; to: number }) {
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
