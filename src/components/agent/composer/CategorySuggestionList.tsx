import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import { IconToolbox } from "central-icons/IconToolbox";

import { CategoryIcon } from "./CategoryIcon";
import type { ReportCategoryDef } from "./reportCategory";
import type { HermesSkillInfo } from "../../../lib/tauri";

export type ComposerSlashCommandItem =
  | { kind: "category"; category: ReportCategoryDef }
  | { kind: "skill"; skill: HermesSkillInfo };

export type CategorySuggestionListProps = {
  items: ComposerSlashCommandItem[];
  command: (item: ComposerSlashCommandItem) => void;
};

export type CategorySuggestionListHandle = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

/** The floating palette that opens when the user types "/" in the composer.
 * Mirrors the os-platform mention list: arrow keys move the highlight, Enter
 * or Tab commits, and the editor's suggestion plugin owns mount/teardown. */
export const CategorySuggestionList = forwardRef<
  CategorySuggestionListHandle,
  CategorySuggestionListProps
>(({ items, command }, ref) => {
  const [selected, setSelected] = useState(0);

  // Snap the highlight back to the top whenever the filtered set changes so a
  // press of Enter never targets a row that just scrolled out of the results.
  useEffect(() => {
    setSelected(0);
  }, [items]);

  const choose = useCallback(
    (index: number) => {
      const item = items[index];
      if (item) command(item);
    },
    [items, command],
  );

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: (event) => {
        if (items.length === 0) return false;
        if (event.key === "ArrowDown") {
          setSelected((index) => (index + 1) % items.length);
          return true;
        }
        if (event.key === "ArrowUp") {
          setSelected((index) => (index - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          choose(selected);
          return true;
        }
        return false;
      },
    }),
    [items, selected, choose],
  );

  if (items.length === 0) {
    return (
      <div className="agent-category-menu agent-category-menu-empty">
        No matches
      </div>
    );
  }

  return (
    <div
      className="agent-category-menu"
      role="listbox"
      aria-label="Tag this message"
    >
      {items.map((item, index) => (
        <button
          key={commandItemKey(item)}
          type="button"
          role="option"
          aria-selected={index === selected}
          data-active={index === selected || undefined}
          // mousedown (not click) so the press commits before the editor's
          // blur can tear the popover down.
          onMouseDown={(event) => {
            event.preventDefault();
            choose(index);
          }}
          onMouseEnter={() => setSelected(index)}
        >
          <span
            className="agent-category-menu-icon"
            data-category={
              item.kind === "category" ? item.category.key : undefined
            }
          >
            {item.kind === "category" ? (
              <CategoryIcon category={item.category.key} size={16} />
            ) : (
              <IconToolbox size={16} aria-hidden />
            )}
          </span>
          <span className="agent-category-menu-copy">
            <span className="agent-category-menu-label">
              {commandItemLabel(item)}
            </span>
            <span className="agent-category-menu-detail">
              {commandItemDetail(item)}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
});
CategorySuggestionList.displayName = "CategorySuggestionList";

function commandItemKey(item: ComposerSlashCommandItem) {
  return item.kind === "category"
    ? `category:${item.category.key}`
    : `skill:${item.skill.name}`;
}

function commandItemLabel(item: ComposerSlashCommandItem) {
  return item.kind === "category" ? item.category.label : `/${item.skill.name}`;
}

function commandItemDetail(item: ComposerSlashCommandItem) {
  if (item.kind === "category") return item.category.hint;
  return item.skill.description?.trim() || "Run this skill for the turn";
}
