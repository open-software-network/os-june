import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HermesTracePanel } from "../components/agent/HermesTracePanel";
import { createHermesTraceBuffer } from "../lib/hermes-trace-buffer";

function seedBuffer() {
  const buffer = createHermesTraceBuffer();
  buffer.recordInbound({
    type: "message.delta",
    session_id: "s1",
    payload: { delta: "hello" },
  });
  buffer.recordInbound({
    type: "future.unknown",
    session_id: "s1",
    payload: { api_key: "sk-abcdef0123456789abcdef0123456789", note: "safe" },
  });
  buffer.recordOutbound({
    sessionId: "s2",
    method: "session.steer",
    params: { text: "focus" },
  });
  return buffer;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("HermesTracePanel", () => {
  beforeEach(() => {
    vi.stubEnv("DEV", true);
  });

  it("does NOT render in production builds even when open", () => {
    vi.stubEnv("DEV", false);
    const buffer = seedBuffer();
    const { container } = render(
      <HermesTracePanel
        buffer={buffer}
        open
        sessionId="s1"
        onClose={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when closed", () => {
    const buffer = seedBuffer();
    const { container } = render(
      <HermesTracePanel
        buffer={buffer}
        open={false}
        sessionId="s1"
        onClose={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("filters to the initially selected session", () => {
    const buffer = seedBuffer();
    render(
      <HermesTracePanel
        buffer={buffer}
        open
        sessionId="s1"
        onClose={vi.fn()}
      />,
    );
    // s1 has the two inbound frames; s2's outbound steer must not show.
    expect(screen.getByText("message.delta")).toBeInTheDocument();
    expect(screen.getByText("future.unknown")).toBeInTheDocument();
    expect(screen.queryByText("session.steer")).not.toBeInTheDocument();
  });

  it("filters by session when the session selector changes", async () => {
    const user = userEvent.setup();
    const buffer = seedBuffer();
    render(
      <HermesTracePanel
        buffer={buffer}
        open
        sessionId="s1"
        onClose={vi.fn()}
      />,
    );
    await user.selectOptions(screen.getByLabelText("Filter by session"), "s2");
    expect(screen.getByText("session.steer")).toBeInTheDocument();
    expect(screen.queryByText("message.delta")).not.toBeInTheDocument();
  });

  it("filters by event kind", async () => {
    const user = userEvent.setup();
    const buffer = seedBuffer();
    render(
      <HermesTracePanel
        buffer={buffer}
        open
        sessionId="s1"
        onClose={vi.fn()}
      />,
    );
    await user.selectOptions(
      screen.getByLabelText("Filter by kind"),
      "unsupported",
    );
    // Only the unsupported inbound frame remains.
    expect(screen.getByText("future.unknown")).toBeInTheDocument();
    expect(screen.queryByText("message.delta")).not.toBeInTheDocument();
  });

  it("highlights unsupported entries", () => {
    const buffer = seedBuffer();
    const { container } = render(
      <HermesTracePanel
        buffer={buffer}
        open
        sessionId="s1"
        onClose={vi.fn()}
      />,
    );
    const flagged = container.querySelector('[data-unsupported="true"]');
    expect(flagged).not.toBeNull();
    expect(
      within(flagged as HTMLElement).getByText("future.unknown"),
    ).toBeInTheDocument();
  });

  it("copies a sanitized export to the clipboard with NO secret values", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);

    const buffer = seedBuffer();
    render(
      <HermesTracePanel
        buffer={buffer}
        open
        sessionId="s1"
        onClose={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Copy trace" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0] as string;
    // The export carries raw type + normalized kind ...
    expect(copied).toContain("future.unknown");
    expect(copied).toContain("unsupported");
    // ... but never the secret value the inbound frame carried.
    expect(copied).not.toContain("sk-abcdef0123456789abcdef0123456789");
    expect(copied).toContain("[redacted]");
  });

  it("invokes onClose from the close button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const buffer = seedBuffer();
    render(
      <HermesTracePanel
        buffer={buffer}
        open
        sessionId="s1"
        onClose={onClose}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Close raw trace" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
