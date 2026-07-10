import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TabBar } from "../components/tabs/TabBar";
import appCss from "../styles/app.css?raw";

// jsdom has no PointerEvent, and testing-library's fallback drops MouseEvent
// init fields (button, clientX) that the drag-reorder handlers read — so give
// it a real constructor.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const tabs = [
  { id: "tab-1", title: "New session", icon: <span aria-hidden /> },
  { id: "tab-2", title: "Notes", icon: <span aria-hidden /> },
];

function renderTabBar(overrides = {}) {
  const props = {
    tabs,
    activeTabId: "tab-1",
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onNew: vi.fn(),
    onReorder: vi.fn(),
    onDragRegionPointerDown: vi.fn(),
    ...overrides,
  };

  const view = render(<TabBar {...props} />);
  return { ...view, props };
}

function cssRuleFor(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{`).exec(appCss);
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  const openIndex = match.index + match[0].length - 1;
  let depth = 0;
  let quote: string | null = null;
  let escapedChar = false;
  for (let index = openIndex; index < appCss.length; index += 1) {
    const char = appCss[index];
    if (quote) {
      if (escapedChar) {
        escapedChar = false;
      } else if (char === "\\") {
        escapedChar = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return appCss.slice(openIndex + 1, index);
    }
  }
  throw new Error(`Unclosed CSS rule for ${selector}`);
}

// The strip measures itself via clientWidth, which jsdom reports as 0 — pin it
// so layout tests can exercise real widths. Returns a restore function.
function mockStripWidth(width: number) {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return this.classList?.contains("tab-strip") ? width : 0;
    },
  });
  return () => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", original);
    } else {
      delete (HTMLElement.prototype as unknown as { clientWidth?: number }).clientWidth;
    }
  };
}

describe("TabBar", () => {
  it("centers tabs in the titlebar band while matching the card gap", () => {
    const barRule = cssRuleFor(".tab-bar");
    const stripRule = cssRuleFor(".tab-strip");
    const tabRule = cssRuleFor(".tab");

    expect(barRule).toContain("align-items: center;");
    expect(stripRule).toContain("gap: var(--sp-2);");
    expect(tabRule).toContain("height: calc(var(--titlebar-h) - var(--sp-2));");
  });

  it("keeps the first tab aligned while preserving paint room", () => {
    const rule = cssRuleFor(".tab-strip");

    expect(rule).toContain("margin-left: calc(-1 * var(--tab-strip-shadow-pad));");
    expect(rule).toContain("padding: var(--tab-strip-shadow-pad);");
    expect(rule).not.toContain("padding-left: 0;");
  });

  it("keeps collapsed tabs clear of the fixed sidebar toggle", () => {
    expect(appCss).toContain("var(--titlebar-tabs-clearance)");
    expect(appCss).not.toContain("var(--control-md) + var(--sp-2) -");
  });

  it("keeps the tab strip full-width when the files panel is open", () => {
    const panelRule = cssRuleFor(
      '.app-shell:has(.agent-workspace[data-artifact-panel="open"]) .main-panel',
    );

    expect(panelRule).toContain("margin-right: calc(var(--agent-files-w) + var(--sp-3));");
    expect(appCss).not.toMatch(
      /\.app-shell:has\(\.agent-workspace\[data-artifact-panel="open"\]\) \.main-column\s*\{[\s\S]*?padding-right:\s*calc\(var\(--agent-files-w\)/,
    );
  });

  it("starts a window drag from empty tab-strip space", () => {
    const { container, props } = renderTabBar();
    const strip = container.querySelector(".tab-strip");

    expect(strip).not.toBeNull();
    fireEvent.pointerDown(strip!);

    expect(props.onDragRegionPointerDown).toHaveBeenCalledTimes(1);
  });

  it("does not start a window drag from tab controls", () => {
    const { props } = renderTabBar();

    fireEvent.pointerDown(screen.getByRole("tab", { name: "New session" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "New tab" }));

    expect(props.onDragRegionPointerDown).not.toHaveBeenCalled();
  });

  it("reorders tabs by dragging one past its neighbor", () => {
    const restoreWidth = mockStripWidth(800);
    vi.useFakeTimers();
    try {
      const { container, props } = renderTabBar();
      const tabEls = Array.from(container.querySelectorAll<HTMLElement>(".tab"));
      expect(tabEls).toHaveLength(2);
      // jsdom does no layout; hand each tab a slot (200px wide, 6px gap).
      tabEls.forEach((el, index) => {
        el.getBoundingClientRect = () =>
          ({
            x: index * 206,
            y: 0,
            left: index * 206,
            top: 0,
            right: index * 206 + 200,
            bottom: 22,
            width: 200,
            height: 22,
            toJSON: () => ({}),
          }) as DOMRect;
      });
      const first = tabEls[0]!;
      fireEvent.pointerDown(first, { button: 0, pointerId: 1, clientX: 100 });
      fireEvent.pointerMove(first, { pointerId: 1, clientX: 400 });
      // Page-wide text selection is locked while the drag is live...
      expect(document.body.style.userSelect).toBe("none");
      fireEvent.pointerUp(first, { pointerId: 1 });

      // The reorder only commits after the dragged tab settles into its slot.
      expect(props.onReorder).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(props.onReorder).toHaveBeenCalledWith(["tab-2", "tab-1"]);
      expect(props.onActivate).toHaveBeenCalledWith("tab-1");
      // ...and released once the drop commits.
      expect(document.body.style.userSelect).toBe("");
    } finally {
      vi.useRealTimers();
      restoreWidth();
    }
  });

  it("swaps a wide dragged tab with a narrow neighbor without overshooting", () => {
    const restoreWidth = mockStripWidth(800);
    vi.useFakeTimers();
    try {
      const threeTabs = [
        { id: "tab-1", title: "Active", icon: <span aria-hidden /> },
        { id: "tab-2", title: "B", icon: <span aria-hidden /> },
        { id: "tab-3", title: "C", icon: <span aria-hidden /> },
      ];
      const { container, props } = renderTabBar({ tabs: threeTabs, activeTabId: "tab-1" });
      const tabEls = Array.from(container.querySelectorAll<HTMLElement>(".tab"));
      expect(tabEls).toHaveLength(3);
      // A wide active pill (160px) among two 40px icon tabs, 6px gaps.
      const rects = [
        { left: 0, width: 160 },
        { left: 166, width: 40 },
        { left: 212, width: 40 },
      ];
      tabEls.forEach((el, index) => {
        const rect = rects[index]!;
        el.getBoundingClientRect = () =>
          ({
            x: rect.left,
            y: 0,
            left: rect.left,
            top: 0,
            right: rect.left + rect.width,
            bottom: 22,
            width: rect.width,
            height: 22,
            toJSON: () => ({}),
          }) as DOMRect;
      });
      const first = tabEls[0]!;
      // 30px of travel is past the halfway point to the first landing (46px),
      // so the swap must register — center-crossing math would demand ~106px.
      fireEvent.pointerDown(first, { button: 0, pointerId: 1, clientX: 50 });
      fireEvent.pointerMove(first, { pointerId: 1, clientX: 80 });
      fireEvent.pointerUp(first, { pointerId: 1 });
      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(props.onReorder).toHaveBeenCalledWith(["tab-2", "tab-1", "tab-3"]);
    } finally {
      vi.useRealTimers();
      restoreWidth();
    }
  });

  it("keeps a plain click an activation, not a drag", () => {
    const restoreWidth = mockStripWidth(800);
    try {
      const { props } = renderTabBar();
      const tab = screen.getByRole("tab", { name: "Notes" });
      fireEvent.pointerDown(tab, { button: 0, pointerId: 1, clientX: 100 });
      fireEvent.pointerUp(tab, { pointerId: 1 });
      fireEvent.click(tab);

      expect(props.onActivate).toHaveBeenCalledWith("tab-2");
      expect(props.onReorder).not.toHaveBeenCalled();
    } finally {
      restoreWidth();
    }
  });

  it("gives the active tab a wide pill once the strip is down to icons", () => {
    const restoreWidth = mockStripWidth(360);
    try {
      const manyTabs = Array.from({ length: 6 }, (_, index) => ({
        id: `tab-${index + 1}`,
        title: `Tab ${index + 1}`,
        icon: <span aria-hidden />,
      }));
      const { container } = renderTabBar({ tabs: manyTabs, activeTabId: "tab-1" });

      expect(container.querySelector(".tab-strip")?.getAttribute("data-size")).toBe("icon");
      // Budgeting the wide active pill folds extra tabs into overflow: 360px
      // fits all 6 at icon width, but only 4 once the active tab holds 160px.
      expect(screen.getAllByRole("tab")).toHaveLength(4);
      expect(screen.getByRole("button", { name: "Show all 6 tabs" })).toBeInTheDocument();

      const activeRule = cssRuleFor('.tab-strip[data-size="icon"] .tab[data-active]');
      expect(activeRule).toContain("flex: 0 1 var(--tab-active-compact-w);");
      const inactiveLabelRule = cssRuleFor(
        '.tab-strip[data-size="icon"] .tab:not([data-active]) .tab-label',
      );
      expect(inactiveLabelRule).toContain("display: none;");
    } finally {
      restoreWidth();
    }
  });

  it("keeps the active tab prominent at the tight size too", () => {
    const restoreWidth = mockStripWidth(600);
    try {
      const manyTabs = Array.from({ length: 6 }, (_, index) => ({
        id: `tab-${index + 1}`,
        title: `Tab ${index + 1}`,
        icon: <span aria-hidden />,
      }));
      const { container } = renderTabBar({ tabs: manyTabs, activeTabId: "tab-1" });

      // 600px leaves the inactive tabs ~76px after the active pill's 160px —
      // labels still fit, so this is "tight", with all six on the strip.
      expect(container.querySelector(".tab-strip")?.getAttribute("data-size")).toBe("tight");
      expect(screen.getAllByRole("tab")).toHaveLength(6);

      // The wide-pill rule covers both compact sizes.
      expect(appCss).toContain(
        '.tab-strip[data-size="tight"] .tab[data-active],\n.tab-strip[data-size="icon"] .tab[data-active] {',
      );
    } finally {
      restoreWidth();
    }
  });

  it("floats the close button over the label's faded tail", () => {
    const closeRule = cssRuleFor(".tab-close");
    const labelRule = cssRuleFor(".tab-label");

    expect(closeRule).toContain("position: absolute;");
    expect(labelRule).toContain("mask-image: linear-gradient(");
    expect(labelRule).not.toContain("text-overflow");
  });

  it("freezes adaptive layout while the sidebar is being resized", () => {
    let observerCallback: ResizeObserverCallback | undefined;
    const OriginalResizeObserver = globalThis.ResizeObserver;
    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        observerCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    // Wide enough that all 6 tabs fit above icon size (no wide-active-pill
    // reservation folding any into overflow).
    let tabStripWidth = 600;
    const originalClientWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientWidth",
    );
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.classList?.contains("tab-strip") ? tabStripWidth : 0;
      },
    });

    const manyTabs = Array.from({ length: 6 }, (_, index) => ({
      id: `tab-${index + 1}`,
      title: `Tab ${index + 1}`,
      icon: <span aria-hidden />,
    }));

    try {
      const { props, rerender } = renderTabBar({
        tabs: manyTabs,
        activeTabId: "tab-1",
      });

      expect(screen.getByRole("tab", { name: "Tab 6" })).toBeInTheDocument();

      rerender(<TabBar {...props} layoutFrozen />);
      tabStripWidth = 120;
      act(() => {
        observerCallback?.(
          [{ contentRect: { width: tabStripWidth } } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });

      expect(screen.getByRole("tab", { name: "Tab 6" })).toBeInTheDocument();

      rerender(<TabBar {...props} layoutFrozen={false} />);

      expect(screen.queryByRole("tab", { name: "Tab 6" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Show all 6 tabs" })).toBeInTheDocument();
    } finally {
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        writable: true,
        value: OriginalResizeObserver,
      });
      if (originalClientWidth) {
        Object.defineProperty(HTMLElement.prototype, "clientWidth", originalClientWidth);
      } else {
        delete (HTMLElement.prototype as unknown as { clientWidth?: number }).clientWidth;
      }
    }
  });
});
