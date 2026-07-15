import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SmoothedStreamingMarkdown } from "../components/agent/SmoothedStreamingMarkdown";

describe("SmoothedStreamingMarkdown", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reveals the first non-empty stream chunk immediately", () => {
    vi.useFakeTimers();
    const view = render(<SmoothedStreamingMarkdown markdown="" running />);

    view.rerender(<SmoothedStreamingMarkdown markdown="First chunk" running />);

    expect(view.container.textContent).toBe("First chunk");
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

  it("flushes stream updates received while the document is hidden", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const view = render(<SmoothedStreamingMarkdown markdown="Hello" running />);

    view.rerender(<SmoothedStreamingMarkdown markdown="Hello hidden backlog" running />);

    expect(view.container.textContent).toBe("Hello hidden backlog");
  });

  it("notifies the transcript when delayed text becomes visible", () => {
    vi.useFakeTimers();
    const onVisibleMarkdownChange = vi.fn();
    const view = render(
      <SmoothedStreamingMarkdown
        markdown="Hello"
        running
        onVisibleMarkdownChange={onVisibleMarkdownChange}
      />,
    );
    onVisibleMarkdownChange.mockClear();
    view.rerender(
      <SmoothedStreamingMarkdown
        markdown="Hello streaming backlog"
        running
        onVisibleMarkdownChange={onVisibleMarkdownChange}
      />,
    );
    expect(onVisibleMarkdownChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(32));

    expect(onVisibleMarkdownChange).toHaveBeenCalledTimes(1);
  });
});
