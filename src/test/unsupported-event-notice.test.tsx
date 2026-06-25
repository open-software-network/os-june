import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnsupportedEventNotice } from "../components/agent/UnsupportedEventNotice";
import type { UnsupportedEventNoticeData } from "../lib/hermes-unsupported-events";

const baseNotice: UnsupportedEventNoticeData = {
  sessionId: "s1",
  type: "future.kind",
  count: 1,
  lastSeen: "2026-06-24T12:00:00.000Z",
  payloadKeys: ["alpha", "beta"],
  payloadPreview: '{\n  "alpha": "safe"\n}',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("UnsupportedEventNotice", () => {
  it("renders the generic recoverable title and body", () => {
    // Production baseline: the title/body must read the same and leak nothing.
    vi.stubEnv("DEV", false);
    render(<UnsupportedEventNotice notice={baseNotice} debugEnabled={false} />);
    expect(
      screen.getByText("June received a Hermes event it does not support yet."),
    ).toBeInTheDocument();
    // Body is generic — it must not leak the raw type or payload preview when
    // not in dev/debug.
    expect(screen.queryByText("future.kind")).not.toBeInTheDocument();
    expect(screen.queryByText(/"alpha": "safe"/)).not.toBeInTheDocument();
  });

  it("does NOT render dev-only details when DEV is false", () => {
    vi.stubEnv("DEV", false);
    render(<UnsupportedEventNotice notice={baseNotice} debugEnabled={false} />);
    expect(screen.queryByText("future.kind")).not.toBeInTheDocument();
    expect(screen.queryByText(/payload/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/"alpha": "safe"/)).not.toBeInTheDocument();
  });

  it("renders sanitized dev details (type, session, payload preview) when DEV is true", () => {
    vi.stubEnv("DEV", true);
    render(<UnsupportedEventNotice notice={baseNotice} debugEnabled={false} />);
    expect(screen.getByText("future.kind")).toBeInTheDocument();
    expect(screen.getByText("s1")).toBeInTheDocument();
    expect(screen.getByText(/"alpha": "safe"/)).toBeInTheDocument();
  });

  it("shows Stop session and wires its callback (always available)", async () => {
    const user = userEvent.setup();
    const onStopSession = vi.fn();
    render(
      <UnsupportedEventNotice
        notice={baseNotice}
        debugEnabled={false}
        onStopSession={onStopSession}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Stop session" }));
    expect(onStopSession).toHaveBeenCalledTimes(1);
  });

  it("hides Report issue unless dev/debug is enabled (no production reporting surface)", () => {
    const onReportIssue = vi.fn();
    const { rerender } = render(
      <UnsupportedEventNotice
        notice={baseNotice}
        debugEnabled={false}
        onReportIssue={onReportIssue}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Report issue" }),
    ).not.toBeInTheDocument();

    rerender(
      <UnsupportedEventNotice
        notice={baseNotice}
        debugEnabled={true}
        onReportIssue={onReportIssue}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Report issue" }),
    ).toBeInTheDocument();
  });

  it("invokes onReportIssue when the dev-gated Report issue is clicked", async () => {
    const user = userEvent.setup();
    const onReportIssue = vi.fn();
    render(
      <UnsupportedEventNotice
        notice={baseNotice}
        debugEnabled={true}
        onReportIssue={onReportIssue}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Report issue" }));
    expect(onReportIssue).toHaveBeenCalledTimes(1);
  });

  it("hides Open raw trace unless dev/debug is enabled", () => {
    const { rerender } = render(
      <UnsupportedEventNotice
        notice={baseNotice}
        debugEnabled={false}
        onOpenRawTrace={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Open raw trace" }),
    ).not.toBeInTheDocument();

    rerender(
      <UnsupportedEventNotice
        notice={baseNotice}
        debugEnabled={true}
        onOpenRawTrace={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Open raw trace" }),
    ).toBeInTheDocument();
  });

  it("invokes onOpenRawTrace with the notice session when clicked", async () => {
    const user = userEvent.setup();
    const onOpenRawTrace = vi.fn();
    render(
      <UnsupportedEventNotice
        notice={baseNotice}
        debugEnabled={true}
        onOpenRawTrace={onOpenRawTrace}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open raw trace" }));
    expect(onOpenRawTrace).toHaveBeenCalledWith("s1");
  });

  it("renders nothing when there is no notice (session unaffected)", () => {
    const { container } = render(
      <UnsupportedEventNotice notice={undefined} debugEnabled={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
