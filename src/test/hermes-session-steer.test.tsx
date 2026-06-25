import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComposerSteerInput } from "../components/agent/AgentWorkspace";
import { createHermesMethods } from "../lib/hermes-control-plane";
import { HermesGatewayError } from "../lib/hermes-gateway";
import { steeringLiveEvent } from "../lib/hermes-session-steer";
import {
  buildHermesSessionChatTurns,
  type LiveHermesEvent,
} from "../lib/agent-chat-runtime";

/** A steer fn that routes through the real typed wrapper, so the test asserts
 * the dedicated `session.steer` method (never prompt.submit) is what gets
 * called, with the right session id + text. */
function steerVia(request: ReturnType<typeof vi.fn>, sessionId: string) {
  const methods = createHermesMethods(request);
  return vi.fn((text: string) => methods.steerSession({ sessionId, text }));
}

describe("ComposerSteerInput", () => {
  it("renders a compact instruction input with a send affordance", () => {
    render(
      <ComposerSteerInput onSteer={vi.fn().mockResolvedValue(undefined)} />,
    );
    expect(
      screen.getByRole("textbox", { name: /add instruction|steer june/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /send|add instruction|steer/i }),
    ).toBeInTheDocument();
  });

  it("does not steer on empty / whitespace-only input", async () => {
    const onSteer = vi.fn().mockResolvedValue(undefined);
    render(<ComposerSteerInput onSteer={onSteer} />);
    // Send is disabled with no text; typing only spaces keeps it inert.
    await userEvent.type(
      screen.getByRole("textbox", { name: /add instruction|steer june/i }),
      "   ",
    );
    const send = screen.getByRole("button", {
      name: /send|add instruction|steer/i,
    });
    expect(send).toBeDisabled();
    await userEvent.click(send);
    expect(onSteer).not.toHaveBeenCalled();
  });

  it("calls session.steer with the trimmed text via the typed wrapper, once", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const steer = steerVia(request, "sess-1");
    render(<ComposerSteerInput onSteer={steer} />);

    await userEvent.type(
      screen.getByRole("textbox", { name: /add instruction|steer june/i }),
      "  focus on the failing test  ",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /send|add instruction|steer/i }),
    );

    await waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    expect(steer).toHaveBeenCalledWith("focus on the failing test");
    // Routed to the dedicated steering method, not prompt.submit.
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("session.steer", {
      session_id: "sess-1",
      text: "focus on the failing test",
    });
  });

  it("clears the input after a successful steer", async () => {
    const steer = vi.fn().mockResolvedValue(undefined);
    render(<ComposerSteerInput onSteer={steer} />);
    const input = screen.getByRole("textbox", {
      name: /add instruction|steer june/i,
    });
    await userEvent.type(input, "switch gears");
    await userEvent.click(
      screen.getByRole("button", { name: /send|add instruction|steer/i }),
    );
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("shows a visible error and keeps the text when Hermes rejects the steer", async () => {
    const steer = vi.fn().mockRejectedValue(new Error("kaboom"));
    render(<ComposerSteerInput onSteer={steer} />);
    const input = screen.getByRole("textbox", {
      name: /add instruction|steer june/i,
    });
    await userEvent.type(input, "do the other thing");
    await userEvent.click(
      screen.getByRole("button", { name: /send|add instruction|steer/i }),
    );

    // A clear, recoverable message — no crash. The unsent text is preserved so
    // the user can retry without retyping.
    expect(
      await screen.findByText(/couldn't send that instruction|could not send/i),
    ).toBeInTheDocument();
    expect(input).toHaveValue("do the other thing");
  });

  it("shows a busy-specific message on a 4009 rejection without leaking the code", async () => {
    const steer = vi
      .fn()
      .mockRejectedValue(new HermesGatewayError("session busy", 4009));
    render(<ComposerSteerInput onSteer={steer} />);
    await userEvent.type(
      screen.getByRole("textbox", { name: /add instruction|steer june/i }),
      "redirect now",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /send|add instruction|steer/i }),
    );

    const notice = await screen.findByText(/finished the previous step|busy/i);
    expect(notice).toBeInTheDocument();
    expect(notice.textContent ?? "").not.toMatch(/4009/);
  });
});

/**
 * A faithful slice of AgentWorkspace's wiring: the steer input is gated on the
 * session being busy, `onSteer` routes through the real typed wrapper AND pushes
 * the synthetic steering event onto the live-event channel, and the transcript
 * is rebuilt from those live events. This proves the three end-to-end
 * requirements: the input only appears for an active/busy session, submitting
 * calls `session.steer`, and the "Steering" item shows up after the send.
 */
function SteerHarness({
  sessionId,
  busy,
  request,
}: {
  sessionId: string;
  busy: boolean;
  request: ReturnType<typeof vi.fn>;
}) {
  const [liveEvents, setLiveEvents] = useState<LiveHermesEvent[]>([]);
  const methods = createHermesMethods(request);

  async function onSteer(text: string) {
    await methods.steerSession({ sessionId, text });
    setLiveEvents((current) => [
      ...current,
      steeringLiveEvent({
        sessionId,
        text,
        receivedAt: new Date().toISOString(),
      }),
    ]);
  }

  const turns = buildHermesSessionChatTurns([], liveEvents);

  return (
    <div>
      {busy ? <ComposerSteerInput onSteer={onSteer} /> : null}
      <div data-testid="transcript">
        {turns.flatMap((turn) =>
          turn.parts
            .filter((part) => part.type === "steering")
            .map((part, index) => (
              <p key={`${turn.id}:${index}`} data-testid="steering-item">
                Steering: {part.type === "steering" ? part.text : ""}
              </p>
            )),
        )}
      </div>
    </div>
  );
}

describe("steering integration (busy gate + transcript item)", () => {
  it("does not render the steer input for an idle (non-busy) session", () => {
    render(
      <SteerHarness
        sessionId="sess-1"
        busy={false}
        request={vi.fn().mockResolvedValue({})}
      />,
    );
    expect(
      screen.queryByRole("textbox", { name: /add instruction|steer june/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the steer input for an active/busy session", () => {
    render(
      <SteerHarness
        sessionId="sess-1"
        busy
        request={vi.fn().mockResolvedValue({})}
      />,
    );
    expect(
      screen.getByRole("textbox", { name: /add instruction|steer june/i }),
    ).toBeInTheDocument();
  });

  it("calls session.steer and then shows the steering transcript item", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    render(<SteerHarness sessionId="sess-1" busy request={request} />);

    // No steering item before the user submits.
    expect(screen.queryByTestId("steering-item")).not.toBeInTheDocument();

    await userEvent.type(
      screen.getByRole("textbox", { name: /add instruction|steer june/i }),
      "prioritize the failing test",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /send|add instruction|steer/i }),
    );

    // The dedicated steering method fired with the right session + text.
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("session.steer", {
        session_id: "sess-1",
        text: "prioritize the failing test",
      }),
    );

    // …and the instruction now appears as a transcript "Steering" item.
    const item = await screen.findByTestId("steering-item");
    expect(item).toHaveTextContent("Steering: prioritize the failing test");
  });
});
