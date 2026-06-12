import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

export type SelectPopoverPlacement = "align-selected" | "below" | "above";

/**
 * Native-macOS popup behavior, shared by every select-trigger surface: the
 * popover prefers sliding up so the currently selected option lines up with
 * the trigger's position, and falls back to a plain below/above dropdown
 * when that would leave the panel (or the viewport).
 */
export function selectPopoverPlacement(
  anchor: HTMLElement | null,
  optionCount: number,
  selectedIndex: number,
): SelectPopoverPlacement {
  if (!anchor) return "align-selected";
  const rect = anchor.getBoundingClientRect();

  const viewportPadding = 12;
  const rowHeight = 28;
  const popoverPadding = 8;
  const popoverHeight = optionCount * rowHeight + popoverPadding;
  const selectedOffset = 2 + selectedIndex * rowHeight;
  const panel = anchor.closest(".main-panel");
  const panelRect = panel?.getBoundingClientRect();
  const topBound = Math.max(viewportPadding, (panelRect?.top ?? 0) + 12);
  const bottomBound = Math.min(
    window.innerHeight - viewportPadding,
    (panelRect?.bottom ?? window.innerHeight) - 12,
  );
  const alignedTop = rect.top - selectedOffset;
  const alignedBottom = alignedTop + popoverHeight;
  const belowBottom = rect.bottom + 4 + popoverHeight;
  const aboveTop = rect.top - 4 - popoverHeight;
  const spaceBelow = bottomBound - rect.bottom;
  const spaceAbove = rect.top - topBound;

  if (alignedTop >= topBound && alignedBottom <= bottomBound) {
    return "align-selected";
  }
  if (belowBottom <= bottomBound || spaceBelow >= spaceAbove) {
    return "below";
  }
  return aboveTop >= topBound ? "above" : "below";
}

export function selectPopoverStyle(
  placement: SelectPopoverPlacement,
  selectedIndex: number,
): CSSProperties {
  if (placement === "below") {
    return { top: "calc(100% + 4px)" };
  }
  if (placement === "above") {
    return { bottom: "calc(100% + 4px)" };
  }
  return { top: -(2 + selectedIndex * 28) };
}

export type SelectOption = {
  value: string;
  label: string;
};

/**
 * The settings select (trigger + listbox popover) as a self-contained
 * control, for surfaces that don't hand-roll the open/placement state the
 * way AppSettings does. Same classes, so it is pixel-identical to the
 * Language and Microphone pickers.
 */
export function Select({
  value,
  options,
  placeholder,
  onChange,
  ariaLabel,
  className,
}: {
  value: string | null;
  options: SelectOption[];
  /** Trigger text while nothing is selected yet. */
  placeholder: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] =
    useState<SelectPopoverPlacement>("align-selected");
  const wrapRef = useRef<HTMLDivElement>(null);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex === -1 ? undefined : options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    if (!open) {
      // An unanswered select has no row to align with, so it opens as a
      // plain dropdown; Math.max keeps the offset math on row 0.
      setPlacement(
        selectedIndex === -1
          ? "below"
          : selectPopoverPlacement(
              wrapRef.current,
              options.length,
              selectedIndex,
            ),
      );
    }
    setOpen((current) => !current);
  }

  return (
    <div
      className={`select-control${className ? ` ${className}` : ""}`}
      ref={wrapRef}
    >
      <button
        type="button"
        className="select-trigger"
        data-placeholder={!selected}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      >
        <span>{selected?.label ?? placeholder}</span>
        <IconChevronDownSmall size={14} />
      </button>
      {open ? (
        <ul
          className="select-popover"
          role="listbox"
          data-placement={placement}
          style={selectPopoverStyle(placement, Math.max(selectedIndex, 0))}
        >
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <li key={option.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-selected={isSelected}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span>{option.label}</span>
                  <span className="select-check" aria-hidden>
                    {isSelected ? <IconCheckmark1Small size={14} /> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
