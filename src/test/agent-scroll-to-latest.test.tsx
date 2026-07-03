import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentScrollToLatestButton } from "../components/agent/AgentWorkspace";

// jsdom reports zero scroll metrics, so a scroller looks pinned to the bottom
// by default. Force the geometry to model a user parked up-thread.
function stubScrollGeometry(
  el: HTMLElement,
  geometry: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(el, "scrollHeight", { value: geometry.scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: geometry.clientHeight, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: geometry.scrollTop, configurable: true });
}

describe("AgentScrollToLatestButton", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays hidden and inert when the transcript is at the bottom", () => {
    const scroller = document.createElement("div");
    scroller.append(document.createElement("div"));
    document.body.append(scroller);
    stubScrollGeometry(scroller, { scrollHeight: 200, clientHeight: 200, scrollTop: 0 });
    const ref = createRef<HTMLDivElement>();
    Object.defineProperty(ref, "current", { value: scroller });

    render(<AgentScrollToLatestButton scrollRef={ref} onJump={vi.fn()} />);

    const button = screen.getByLabelText("Scroll to latest");
    expect(button.getAttribute("data-visible")).toBeNull();
    expect(button.getAttribute("aria-hidden")).toBe("true");
    expect(button.getAttribute("tabindex")).toBe("-1");
  });

  it("appears when scrolled up and jumps on click", () => {
    const scroller = document.createElement("div");
    scroller.append(document.createElement("div"));
    document.body.append(scroller);
    // 1000 of content, 400 visible, parked at the very top: far from bottom.
    stubScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    const ref = createRef<HTMLDivElement>();
    Object.defineProperty(ref, "current", { value: scroller });
    const onJump = vi.fn();

    render(<AgentScrollToLatestButton scrollRef={ref} onJump={onJump} />);

    const button = screen.getByLabelText("Scroll to latest");
    expect(button.getAttribute("data-visible")).toBe("true");
    expect(button.getAttribute("aria-hidden")).toBeNull();
    expect(button.getAttribute("tabindex")).toBeNull();

    fireEvent.click(button);
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("re-checks visibility when a scroll event fires", () => {
    const scroller = document.createElement("div");
    scroller.append(document.createElement("div"));
    document.body.append(scroller);
    stubScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    const ref = createRef<HTMLDivElement>();
    Object.defineProperty(ref, "current", { value: scroller });

    render(<AgentScrollToLatestButton scrollRef={ref} onJump={vi.fn()} />);

    const button = screen.getByLabelText("Scroll to latest");
    expect(button.getAttribute("data-visible")).toBe("true");

    // Scroll to the live edge: the pill should retire.
    stubScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    fireEvent.scroll(scroller);
    expect(button.getAttribute("data-visible")).toBeNull();
  });
});
