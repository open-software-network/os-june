import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SmoothedStreamingMarkdown } from "../components/agent/SmoothedStreamingMarkdown";

describe("SmoothedStreamingMarkdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reveals appended stream text over a short catch-up window", () => {
    vi.useFakeTimers();
    const view = render(<SmoothedStreamingMarkdown markdown="Hello" running repairProse />);
    view.rerender(
      <SmoothedStreamingMarkdown
        markdown="Hello from a larger provider chunk"
        running
        repairProse
      />,
    );

    expect(view.container.textContent).toBe("Hello");
    act(() => vi.advanceTimersByTime(32));
    expect(view.container.textContent?.startsWith("Hello")).toBe(true);
    expect(view.container.textContent).not.toBe("Hello");
    expect(view.container.textContent).not.toBe("Hello from a larger provider chunk");

    act(() => vi.advanceTimersByTime(1_000));
    expect(view.container.textContent).toBe("Hello from a larger provider chunk");
  });

  it("flushes immediately when the turn completes", () => {
    vi.useFakeTimers();
    const view = render(<SmoothedStreamingMarkdown markdown="Hello" running />);
    view.rerender(<SmoothedStreamingMarkdown markdown="Hello streaming backlog" running />);
    expect(view.container.textContent).toBe("Hello");

    view.rerender(<SmoothedStreamingMarkdown markdown="Hello streaming backlog" running={false} />);
    expect(view.container.textContent).toBe("Hello streaming backlog");
  });

  it("does not animate through a reconciled text replacement", () => {
    vi.useFakeTimers();
    const view = render(<SmoothedStreamingMarkdown markdown="Draft answer" running />);
    view.rerender(<SmoothedStreamingMarkdown markdown="Corrected answer" running />);
    expect(view.container.textContent).toBe("Corrected answer");
  });
});
