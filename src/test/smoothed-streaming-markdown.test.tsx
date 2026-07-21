import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const motionPreference = vi.hoisted(() => ({ reduced: false }));

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return {
    ...actual,
    useReducedMotion: () => motionPreference.reduced,
  };
});

import {
  holdbackSafeEnd,
  SmoothedStreamingMarkdown,
} from "../components/agent/SmoothedStreamingMarkdown";

describe("SmoothedStreamingMarkdown", () => {
  afterEach(() => {
    motionPreference.reduced = false;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reveals the first non-empty stream chunk immediately", () => {
    vi.useFakeTimers();
    const view = render(<SmoothedStreamingMarkdown markdown="" running />);

    view.rerender(<SmoothedStreamingMarkdown markdown="First chunk" running />);

    expect(view.container.textContent).toBe("First chunk");
  });

  it("applies inline holdback when the component mounts on the first live delta", () => {
    const view = render(<SmoothedStreamingMarkdown markdown="before **bold" running />);

    expect(view.container.textContent).toBe("before");
    expect(view.container.textContent).not.toContain("**");
  });

  it("applies table holdback when the component mounts on the first live delta", () => {
    const view = render(<SmoothedStreamingMarkdown markdown="| Metric | Q1 |" running />);

    expect(view.container.textContent).toBe("");
  });

  it("withholds an ambiguous block prefix until its heading content arrives", () => {
    const view = render(<SmoothedStreamingMarkdown markdown="#" running />);
    expect(view.container.textContent).toBe("");

    view.rerender(<SmoothedStreamingMarkdown markdown="# Heading" running />);

    expect(view.container.querySelector("h2")?.textContent).toBe("Heading");
    expect(view.container.textContent).not.toContain("#");
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

  it("renders streaming prose without presentation spans for reduced motion", () => {
    motionPreference.reduced = true;

    const view = render(<SmoothedStreamingMarkdown markdown="No motion" running />);

    expect(view.container.textContent).toBe("No motion");
    expect(view.container.querySelector(".agent-stream-word")).toBeNull();
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

    const markdown = view.container.querySelector(".agent-markdown");
    expect(markdown).toHaveClass("agent-stream-settling");
    // Child word animations bubble through the same handler but must not end
    // the root settle clock early.
    fireEvent.animationEnd(words[0] as Element, {
      animationName: "agent-stream-word-in",
    });
    expect(view.container.querySelectorAll(".agent-stream-word")).toHaveLength(2);

    fireEvent.animationEnd(markdown as Element, {
      animationName: "agent-stream-settle-clock",
    });
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

  it("keeps existing prose mounted when a later inline construct completes", () => {
    vi.useFakeTimers();
    const view = render(<SmoothedStreamingMarkdown markdown="" running />);
    view.rerender(<SmoothedStreamingMarkdown markdown="Hello" running />);
    const firstWord = view.container.querySelector(".agent-stream-word");

    view.rerender(<SmoothedStreamingMarkdown markdown="Hello **world**" running />);
    act(() => vi.advanceTimersByTime(80));

    const words = view.container.querySelectorAll(".agent-stream-word");
    expect([...words].map((word) => word.textContent)).toEqual(["Hello", "world"]);
    expect(words[0]).toBe(firstWord);
    expect(view.container.querySelector("strong")?.textContent).toBe("world");
  });

  it("still renders valid emphasis after tightening literal-star handling", () => {
    const view = render(<SmoothedStreamingMarkdown markdown="before *valid words*" running />);

    expect(view.container.querySelector("em")?.textContent).toBe("valid words");
  });

  it("excludes inline and fenced code from word-fade spans", () => {
    const view = render(
      <SmoothedStreamingMarkdown
        markdown={"Fade prose around `inline code`.\n\n```ts\nconst value = 1;\n```"}
        running
      />,
    );

    expect(view.container.querySelector("p .agent-stream-word")).not.toBeNull();
    expect(view.container.querySelector("code .agent-stream-word")).toBeNull();
  });

  it("keeps revealing after a streamed code fence closes", () => {
    vi.useFakeTimers();
    const view = render(<SmoothedStreamingMarkdown markdown={"```ts\nconst value = 1;"} running />);

    view.rerender(
      <SmoothedStreamingMarkdown
        markdown={"```ts\nconst value = 1;\n```\nFollowing prose"}
        running
      />,
    );
    act(() => vi.advanceTimersByTime(80));

    expect(view.container.querySelector("pre code")?.textContent).toBe("const value = 1;");
    expect(view.container.querySelector("p")?.textContent).toBe("Following prose");
    expect(view.container.textContent).not.toContain("`");
  });

  it("withholds an incomplete trailing construct until it closes, never flashing the syntax", () => {
    vi.useFakeTimers();
    const view = render(<SmoothedStreamingMarkdown markdown="" running />);

    // The unclosed **bold is held back, so only the safe prefix shows and the
    // literal ** never reaches the DOM.
    view.rerender(<SmoothedStreamingMarkdown markdown="before **bold" running />);
    // The renderer trims the paragraph's trailing space; the point is that
    // "bold" and the literal ** are both withheld.
    expect(view.container.textContent).toBe("before");
    expect(view.container.textContent).not.toContain("**");

    // Once the closing ** streams in, the word moves into <strong> on a fresh
    // reveal instead of remounting a already-visible span.
    view.rerender(<SmoothedStreamingMarkdown markdown="before **bold** after" running />);
    act(() => vi.advanceTimersByTime(80));
    expect(view.container.querySelector("strong")?.textContent).toBe("bold");
    expect(view.container.textContent).toBe("before bold after");
    expect(view.container.textContent).not.toContain("**");
  });

  it("reveals an over-long construct without letting a later close restart its fade", () => {
    vi.useFakeTimers();
    const long = "x".repeat(200);
    const view = render(<SmoothedStreamingMarkdown markdown="" running />);

    view.rerender(<SmoothedStreamingMarkdown markdown={`start *${long}`} running />);

    // Past the holdback cap, never stall. Fade spans are disabled for this
    // rare fallback so a closing delimiter cannot remount the passage at
    // opacity zero and replay the full 1.5 second fade.
    expect(view.container.textContent).toBe(`start *${long}`);
    expect(view.container.querySelector(".agent-stream-word")).toBeNull();

    view.rerender(<SmoothedStreamingMarkdown markdown={`start *${long}*`} running />);
    act(() => vi.advanceTimersByTime(80));

    expect(view.container.querySelector("em")?.textContent).toBe(long);
    expect(view.container.querySelector(".agent-stream-word")).toBeNull();
  });

  it("does not withhold a whitespace-surrounded literal asterisk", () => {
    vi.useFakeTimers();
    const text = "Result: 2 * 3 = 6 and the whole sentence stays visible.";
    const view = render(<SmoothedStreamingMarkdown markdown="" running />);

    view.rerender(<SmoothedStreamingMarkdown markdown={text} running />);

    expect(view.container.textContent).toBe(text);
  });

  it("keeps repeated multiplication stars literal and preserves prior words", () => {
    vi.useFakeTimers();
    const view = render(<SmoothedStreamingMarkdown markdown="" running />);
    view.rerender(<SmoothedStreamingMarkdown markdown="2 * 3" running />);
    const three = [...view.container.querySelectorAll(".agent-stream-word")].find(
      (word) => word.textContent === "3",
    );

    view.rerender(<SmoothedStreamingMarkdown markdown="2 * 3 * 4" running />);
    act(() => vi.advanceTimersByTime(80));

    expect(view.container.textContent).toBe("2 * 3 * 4");
    expect(view.container.querySelector("em")).toBeNull();
    expect(
      [...view.container.querySelectorAll(".agent-stream-word")].find(
        (word) => word.textContent === "3",
      ),
    ).toBe(three);
  });

  it("withholds a possible table header until its separator establishes the table", () => {
    vi.useFakeTimers();
    const view = render(<SmoothedStreamingMarkdown markdown="" running />);

    view.rerender(<SmoothedStreamingMarkdown markdown="| Metric | Q1 |" running />);
    expect(view.container.textContent).toBe("");

    view.rerender(<SmoothedStreamingMarkdown markdown={"| Metric | Q1 |\n"} running />);
    expect(view.container.textContent).toBe("");

    view.rerender(<SmoothedStreamingMarkdown markdown={"| Metric | Q1 |\n| --"} running />);
    expect(view.container.textContent).toBe("");

    view.rerender(
      <SmoothedStreamingMarkdown
        markdown={"| Metric | Q1 |\n| --- | --- |\n| Revenue | 1.2M |\n"}
        running
      />,
    );
    act(() => vi.advanceTimersByTime(80));

    expect(view.container.querySelector("th")?.textContent).toBe("Metric");
    expect(view.container.textContent).toBe("MetricQ1Revenue1.2M");
  });

  it("withholds a possible table nested in a blockquote", () => {
    vi.useFakeTimers();
    const view = render(<SmoothedStreamingMarkdown markdown="" running />);

    view.rerender(<SmoothedStreamingMarkdown markdown="> | Metric | Q1 |" running />);
    expect(view.container.textContent).toBe("");

    view.rerender(
      <SmoothedStreamingMarkdown
        markdown={"> | Metric | Q1 |\n> | --- | --- |\n> | Revenue | 1.2M |\n"}
        running
      />,
    );
    act(() => vi.advanceTimersByTime(80));

    expect(view.container.querySelector("blockquote th")?.textContent).toBe("Metric");
    expect(view.container.textContent).toBe("MetricQ1Revenue1.2M");
  });

  it("flushes a withheld tail when the turn completes", () => {
    vi.useFakeTimers();
    const view = render(<SmoothedStreamingMarkdown markdown="" running />);
    view.rerender(<SmoothedStreamingMarkdown markdown="keep **open" running />);
    expect(view.container.textContent).toBe("keep");

    view.rerender(<SmoothedStreamingMarkdown markdown="keep **open" running={false} />);
    expect(view.container.textContent).toBe("keep **open");
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

describe("holdbackSafeEnd", () => {
  it("never moves the safe reveal boundary backward for known streaming shapes", () => {
    const targets = [
      "before **bold** after",
      "before *open `code` tail* after",
      "before *open\n| close*\nnot a separator",
      "before ~~struck~~ after",
      "| Metric | Q1 |\n| --- | --- |\n| Revenue | 1.2M |",
      "> | Metric | Q1 |\n> | --- | --- |\n> | Revenue | 1.2M |",
      "```ts\nconst value = 1;\n```\nFollowing prose",
      "# Heading",
      "1. First item",
    ];

    for (const target of targets) {
      let previous = 0;
      for (let end = 1; end <= target.length; end += 1) {
        const current = holdbackSafeEnd(target.slice(0, end));
        expect(current, `${JSON.stringify(target)} at ${end}`).toBeGreaterThanOrEqual(previous);
        previous = current;
      }
    }
  });

  it("holds ambiguous block prefixes on the editable final line", () => {
    for (const prefix of ["#", "## ", "- ", "1", "1.", ">", "> #"]) {
      expect(holdbackSafeEnd(prefix), prefix).toBe(0);
    }
  });

  it("does not treat a blank quoted line as a pending table separator", () => {
    const text = "> | Not a table |\n>\n> Explanation";

    expect(holdbackSafeEnd(text)).toBe(text.length);
  });

  it("keeps an earlier opener active across a completed inner code span", () => {
    const text = "before *open `code` tail";

    expect(holdbackSafeEnd(text)).toBe("before ".length);
  });

  it("keeps a completed inline opener hidden when it crosses a pending block", () => {
    const text = "before *open\n| close*";

    expect(holdbackSafeEnd(text)).toBe("before ".length);
  });

  it("never moves backward when a trailing tilde becomes strikethrough", () => {
    const singleTilde = "before ~";
    const doubleTilde = "before ~~open";

    expect(holdbackSafeEnd(singleTilde)).toBe("before ".length);
    expect(holdbackSafeEnd(doubleTilde)).toBe("before ".length);
    expect(holdbackSafeEnd("before ~literal")).toBe("before ~literal".length);
  });

  it("does not hold a list-marker line", () => {
    const text = "- item";
    expect(holdbackSafeEnd(text)).toBe(text.length);
  });

  it("does not hold inside an open code fence", () => {
    const text = "```\ncode *unclosed";
    expect(holdbackSafeEnd(text)).toBe(text.length);
  });

  it("holds an incomplete link", () => {
    const text = "see [docs](https://exa";
    expect(holdbackSafeEnd(text)).toBe("see ".length);
  });

  it("does not hold a plain bracket", () => {
    const text = "item [1] done";
    expect(holdbackSafeEnd(text)).toBe(text.length);
  });
});
