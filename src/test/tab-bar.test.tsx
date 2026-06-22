import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TabBar } from "../components/tabs/TabBar";
import appCss from "../styles/app.css?raw";

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

    expect(rule).toContain(
      "margin-left: calc(-1 * var(--tab-strip-shadow-pad));",
    );
    expect(rule).toContain("padding: var(--tab-strip-shadow-pad);");
    expect(rule).not.toContain("padding-left: 0;");
  });

  it("keeps collapsed tabs clear of the fixed sidebar toggle", () => {
    expect(appCss).toContain("var(--titlebar-tabs-clearance)");
    expect(appCss).not.toContain("var(--control-md) + var(--sp-2) -");
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

    let tabStripWidth = 360;
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

      expect(
        screen.queryByRole("tab", { name: "Tab 6" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Show all 6 tabs" }),
      ).toBeInTheDocument();
    } finally {
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        writable: true,
        value: OriginalResizeObserver,
      });
      if (originalClientWidth) {
        Object.defineProperty(
          HTMLElement.prototype,
          "clientWidth",
          originalClientWidth,
        );
      } else {
        delete (HTMLElement.prototype as unknown as { clientWidth?: number })
          .clientWidth;
      }
    }
  });
});
