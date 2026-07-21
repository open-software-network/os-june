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

  it("batches appended stream text into one whole-chunk reveal per beat", () => {
    vi.useFakeTimers();
    const view = render(<SmoothedStreamingMarkdown markdown="Hello" running repairProse />);
    view.rerender(
      <SmoothedStreamingMarkdown
        markdown="Hello from a larger provider chunk"
        running
        repairProse
      />,
    );

    // The delta holds for one batch interval, then mounts all at once — a
    // chunk fading in as a unit, never a partial left-to-right dribble.
    expect(view.container.textContent).toBe("Hello");
    act(() => vi.advanceTimersByTime(80));
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

  it("fades streamed words in and keeps the spans through the settle window", () => {
    vi.useFakeTimers();
    const view = render(<SmoothedStreamingMarkdown markdown="" running />);
    view.rerender(<SmoothedStreamingMarkdown markdown="Hello brave" running />);

    const words = view.container.querySelectorAll(".agent-stream-word");
    expect([...words].map((word) => word.textContent)).toEqual(["Hello", "brave"]);

    // Completion must not unwrap the spans mid-fade — the trailing gradient
    // settles on its own clock, then the turn re-renders as plain text.
    view.rerender(<SmoothedStreamingMarkdown markdown="Hello brave" running={false} />);
    expect(view.container.querySelectorAll(".agent-stream-word")).toHaveLength(2);

    act(() => vi.advanceTimersByTime(1_700));
    expect(view.container.querySelectorAll(".agent-stream-word")).toHaveLength(0);
    expect(view.container.textContent).toBe("Hello brave");
  });

  it("keeps earlier word spans mounted as text appends so they do not re-fade", () => {
    vi.useFakeTimers();
    const view = render(<SmoothedStreamingMarkdown markdown="" running />);
    view.rerender(<SmoothedStreamingMarkdown markdown="Hello" running />);
    const firstWord = view.container.querySelector(".agent-stream-word");

    view.rerender(<SmoothedStreamingMarkdown markdown="Hello world" running />);
    act(() => vi.advanceTimersByTime(1_000));

    const words = view.container.querySelectorAll(".agent-stream-word");
    expect(words).toHaveLength(2);
    expect(words[0]).toBe(firstWord);
    expect(words[1]?.textContent).toBe("world");
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

    act(() => vi.advanceTimersByTime(80));

    expect(onVisibleMarkdownChange).toHaveBeenCalledTimes(1);
  });
});
