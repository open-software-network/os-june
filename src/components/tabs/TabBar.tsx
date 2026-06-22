import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from "react";
import { HoverTip } from "../ui/HoverTip";
import { primaryShortcutLabel } from "../../lib/platform";

export type TabItem = {
  id: string;
  title: string;
  icon: ReactNode;
};

type TabBarProps = {
  tabs: TabItem[];
  activeTabId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onNew: () => void;
  layoutFrozen?: boolean;
  onDragRegionPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
};

type TabMenu = { tabId: string; x: number; y: number };

const MENU_WIDTH = 168;
// Layout budget used to decide how many tabs fit before the rest fold into the
// overflow popover. Kept in sync with the CSS (gap = --sp-2, the +/overflow
// buttons are ~24px). MIN_TAB is the narrowest a tab shrinks to — a centered
// icon — before it overflows into the popover; it must match the .tab
// min-width.
const GAP = 6;
const MIN_TAB = 40;
const BTN = 24;

type Layout = { visible: TabItem[]; hidden: TabItem[] };

function computeLayout(
  tabs: TabItem[],
  activeTabId: string,
  available: number,
): Layout {
  // Reserve the "+" button. If every tab fits at MIN_TAB, show them all.
  const forAll = available - BTN - GAP;
  const capAll = Math.floor((forAll + GAP) / (MIN_TAB + GAP));
  if (tabs.length <= capAll || !Number.isFinite(available)) {
    return { visible: tabs, hidden: [] };
  }
  // Otherwise reserve the overflow button too and fold the rest away.
  const forSome = available - BTN - GAP - BTN - GAP;
  const count = Math.max(1, Math.floor((forSome + GAP) / (MIN_TAB + GAP)));
  const visible = tabs.slice(0, count);
  const hidden = tabs.slice(count);
  // The focused tab must stay on the strip: swap it into the last visible slot.
  if (!visible.some((t) => t.id === activeTabId)) {
    const active = tabs.find((t) => t.id === activeTabId);
    if (active && visible.length > 0) {
      const displaced = visible[visible.length - 1]!;
      visible[visible.length - 1] = active;
      return {
        visible,
        hidden: [displaced, ...hidden.filter((t) => t.id !== activeTabId)],
      };
    }
  }
  return { visible, hidden };
}

// The width each visible tab resolves to under flex (equal share of the space
// left after the +/overflow buttons and gaps), clamped like the CSS.
function effectiveTabWidth(
  count: number,
  hasOverflow: boolean,
  available: number,
): number {
  if (!Number.isFinite(available) || count <= 0)
    return Number.POSITIVE_INFINITY;
  const buttons = BTN + (hasOverflow ? BTN : 0);
  const items = count + (hasOverflow ? 1 : 0) + 1;
  const gaps = Math.max(0, items - 1) * GAP;
  const forTabs = available - buttons - gaps;
  const raw = forTabs / count;
  const maxW = Math.min(240, available * 0.25);
  return Math.max(MIN_TAB, Math.min(maxW, raw));
}

export function TabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onCloseOthers,
  onNew,
  layoutFrozen = false,
  onDragRegionPointerDown,
}: TabBarProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const layoutFrozenRef = useRef(layoutFrozen);
  const pendingAvailableRef = useRef<number | null>(null);
  const [available, setAvailable] = useState(Number.POSITIVE_INFINITY);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const newTabShortcut = primaryShortcutLabel("T");

  function setMeasuredAvailable(width: number) {
    if (layoutFrozenRef.current) {
      pendingAvailableRef.current = width;
      return;
    }
    setAvailable(width);
  }

  useLayoutEffect(() => {
    layoutFrozenRef.current = layoutFrozen;
    if (layoutFrozen) return;
    const width = pendingAvailableRef.current ?? stripRef.current?.clientWidth;
    pendingAvailableRef.current = null;
    if (typeof width === "number") setAvailable(width);
  }, [layoutFrozen]);

  // Track the strip's content width so we know how many tabs fit.
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    setMeasuredAvailable(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number") setMeasuredAvailable(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { visible, hidden } = computeLayout(tabs, activeTabId, available);
  // A lone tab carries no meaning to switch between, but the strip stays so the
  // "+" affordance is always discoverable.
  const showClose = tabs.length > 1;

  // How wide each visible tab actually renders, so the strip can shed the label
  // and then the close button as it tightens — ending at a centered icon, the
  // moment the close can't sit with nice padding. Deterministic (vs. relying on
  // CSS container queries to fire) since we already know the width.
  const tabWidth = effectiveTabWidth(
    visible.length,
    hidden.length > 0,
    available,
  );
  const size = tabWidth < 64 ? "icon" : tabWidth < 120 ? "tight" : "full";

  // The overflow popover is meaningless once everything fits again.
  useEffect(() => {
    if (hidden.length === 0) setOverflowOpen(false);
  }, [hidden.length]);

  // Dismiss the right-click menu / overflow popover on outside click or Escape.
  useEffect(() => {
    if (!menu && !overflowOpen) return;
    const close = () => {
      setMenu(null);
      setOverflowOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, overflowOpen]);

  function handleTabKeyDown(event: KeyboardEvent<HTMLDivElement>, id: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate(id);
    }
  }

  function handleAuxClick(event: MouseEvent<HTMLDivElement>, id: string) {
    // Middle-click closes, matching every browser.
    if (event.button === 1 && showClose) {
      event.preventDefault();
      onClose(id);
    }
  }

  function handleContextMenu(event: MouseEvent<HTMLDivElement>, id: string) {
    // preventDefault both opens our menu and signals the native context-menu
    // guard to stand down.
    event.preventDefault();
    setOverflowOpen(false);
    setMenu({
      tabId: id,
      x: Math.min(event.clientX, window.innerWidth - MENU_WIDTH),
      y: event.clientY,
    });
  }

  function handleDragRegionPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    onDragRegionPointerDown?.(event);
  }

  function renderTab(tab: TabItem) {
    const active = tab.id === activeTabId;
    return (
      <div
        key={tab.id}
        className="tab"
        role="tab"
        tabIndex={0}
        aria-selected={active}
        data-active={active || undefined}
        title={tab.title}
        onClick={() => onActivate(tab.id)}
        onAuxClick={(event) => handleAuxClick(event, tab.id)}
        onContextMenu={(event) => handleContextMenu(event, tab.id)}
        onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
      >
        <span className="tab-icon" aria-hidden>
          {tab.icon}
        </span>
        <span className="tab-label">{tab.title}</span>
        {showClose ? (
          <button
            type="button"
            className="tab-close"
            aria-label={`Close ${tab.title}`}
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <IconCrossSmall size={12} />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="tab-bar"
      role="tablist"
      aria-label="Open tabs"
      data-tauri-drag-region
      onPointerDown={handleDragRegionPointerDown}
    >
      <div
        className="tab-strip"
        ref={stripRef}
        data-size={size}
        data-tauri-drag-region
        onPointerDown={handleDragRegionPointerDown}
      >
        {visible.map(renderTab)}
        {hidden.length > 0 ? (
          <button
            type="button"
            className="tab-overflow"
            // The popover is a full switcher listing every open tab (the badge
            // counts how many are currently off-strip), so the label says so.
            aria-label={`Show all ${tabs.length} tabs`}
            aria-expanded={overflowOpen}
            onClick={(event) => {
              event.stopPropagation();
              setMenu(null);
              setOverflowOpen((open) => !open);
            }}
          >
            <span className="tab-overflow-count">{hidden.length}</span>
            <IconChevronDownSmall size={14} />
          </button>
        ) : null}
        <HoverTip
          className="tab-new-anchor"
          compact
          // "Ctrl T" (Windows) needs more room than the tight "⌘T".
          width={newTabShortcut.length > 3 ? 132 : 100}
          delay={550}
          tip={
            <span className="tab-tip">
              New tab
              <span className="tab-tip-kbd">{newTabShortcut}</span>
            </span>
          }
        >
          <button
            type="button"
            className="tab-new"
            aria-label="New tab"
            onClick={onNew}
          >
            <IconPlusMedium size={14} />
          </button>
        </HoverTip>
      </div>

      {overflowOpen ? (
        <div
          className="tab-overflow-popover"
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className="tab-overflow-item"
                role="menuitem"
                tabIndex={0}
                data-active={active || undefined}
                onClick={() => {
                  onActivate(tab.id);
                  setOverflowOpen(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onActivate(tab.id);
                    setOverflowOpen(false);
                  }
                }}
              >
                <span className="tab-overflow-icon" aria-hidden>
                  {tab.icon}
                </span>
                <span className="tab-overflow-title">{tab.title}</span>
                {showClose ? (
                  <button
                    type="button"
                    className="tab-overflow-close"
                    aria-label={`Close ${tab.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onClose(tab.id);
                    }}
                  >
                    <IconCrossSmall size={12} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {menu ? (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose(menu.tabId);
              setMenu(null);
            }}
          >
            Close tab
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={tabs.length <= 1}
            onClick={() => {
              onCloseOthers(menu.tabId);
              setMenu(null);
            }}
          >
            Close other tabs
          </button>
        </div>
      ) : null}
    </div>
  );
}
