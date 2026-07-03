import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { IconNoteText } from "central-icons/IconNoteText";

import { displayNoteTitle } from "./noteReference";
import type { NoteListItemDto } from "../../../lib/tauri";

export type NoteSuggestionListProps = {
  items: NoteListItemDto[];
  command: (item: NoteListItemDto) => void;
};

export type NoteSuggestionListHandle = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

/** The floating palette that opens when the user types "@" in the composer.
 * It mirrors the slash palette's keyboard contract but only lists notes. */
export const NoteSuggestionList = forwardRef<NoteSuggestionListHandle, NoteSuggestionListProps>(
  ({ items, command }, ref) => {
    const [selected, setSelected] = useState(0);
    const [activeSource, setActiveSource] = useState<"keyboard" | "pointer" | null>(null);
    const [fade, setFade] = useState({ top: false, bottom: false });
    const menuRef = useRef<HTMLDivElement | null>(null);
    const itemIds = items.map((item) => item.id).join("\u0000");
    const lastItemIdsRef = useRef(itemIds);

    const updateFade = useCallback(() => {
      const el = menuRef.current;
      if (!el) return;
      const canScroll = el.scrollHeight - el.clientHeight > 1;
      const atTop = el.scrollTop <= 1;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      setFade((prev) => {
        const top = canScroll && !atTop;
        const bottom = canScroll && !atBottom;
        return prev.top === top && prev.bottom === bottom ? prev : { top, bottom };
      });
    }, []);

    useLayoutEffect(() => {
      // Reset the highlight whenever filtering changes the result set so Enter
      // always targets a visible row.
      if (lastItemIdsRef.current !== itemIds) {
        lastItemIdsRef.current = itemIds;
        setSelected(0);
        setActiveSource(null);
      }
      updateFade();
      const frame = window.requestAnimationFrame(updateFade);
      return () => window.cancelAnimationFrame(frame);
    }, [itemIds, updateFade]);

    useEffect(() => {
      const el = menuRef.current;
      if (!el || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(updateFade);
      observer.observe(el);
      return () => observer.disconnect();
    }, [updateFade]);

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
            setSelected((index) => {
              setActiveSource("keyboard");
              return (index + 1) % items.length;
            });
            return true;
          }
          if (event.key === "ArrowUp") {
            setSelected((index) => {
              setActiveSource("keyboard");
              return (index - 1 + items.length) % items.length;
            });
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
      return <div className="agent-category-menu agent-category-menu-empty">No notes found</div>;
    }

    return (
      <div className="agent-category-menu-shell agent-note-suggestion-menu-shell">
        <div
          className="agent-category-menu-scroll-wrap"
          data-fade-top={fade.top || undefined}
          data-fade-bottom={fade.bottom || undefined}
        >
          <div
            ref={menuRef}
            className="agent-category-menu agent-note-suggestion-menu"
            role="listbox"
            aria-label="Reference a note"
            onScroll={() => {
              updateFade();
            }}
          >
            {items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={index === selected}
                data-active={activeSource && index === selected ? true : undefined}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(index);
                }}
                onMouseEnter={() => {
                  setSelected(index);
                  setActiveSource("pointer");
                }}
                onFocus={() => {
                  setSelected(index);
                  setActiveSource("keyboard");
                }}
              >
                <span className="agent-category-menu-icon agent-note-suggestion-menu-icon">
                  <IconNoteText size={16} aria-hidden />
                </span>
                <span className="agent-category-menu-copy">
                  <span className="agent-category-menu-label agent-note-suggestion-menu-label">
                    {displayNoteTitle(item.title)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  },
);
NoteSuggestionList.displayName = "NoteSuggestionList";
