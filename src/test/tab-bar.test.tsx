import { fireEvent, render, screen } from "@testing-library/react";
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
  const escaped = selector.replace(/\./g, "\\.");
  const match = appCss.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1];
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
});
