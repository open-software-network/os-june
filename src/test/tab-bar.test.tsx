import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TabBar } from "../components/tabs/TabBar";

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

describe("TabBar", () => {
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
