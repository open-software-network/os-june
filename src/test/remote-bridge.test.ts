import { describe, expect, it } from "vitest";
import { agentEventToRemoteFrame } from "../lib/remote-bridge";
import type { HermesGatewayEvent } from "../lib/hermes-gateway";

function event(
  type: HermesGatewayEvent["type"],
  payload?: Record<string, unknown>,
): HermesGatewayEvent {
  return { type, payload };
}

describe("agentEventToRemoteFrame", () => {
  it("streams assistant deltas as delta frames", () => {
    expect(
      agentEventToRemoteFrame(event("message.delta", { text: "Hello" })),
    ).toBe(JSON.stringify({ type: "delta", text: "Hello" }));
    // Empty deltas produce nothing to send.
    expect(agentEventToRemoteFrame(event("message.delta", { text: "" }))).toBe(
      null,
    );
  });

  it("ends a turn with a done frame", () => {
    expect(agentEventToRemoteFrame(event("message.complete"))).toBe(
      JSON.stringify({ type: "done" }),
    );
  });

  it("forwards errors with a message", () => {
    expect(
      agentEventToRemoteFrame(event("error", { message: "boom" })),
    ).toBe(JSON.stringify({ type: "error", message: "boom" }));
  });

  it("tells the phone to finish approvals on the Mac", () => {
    const frame = agentEventToRemoteFrame(event("approval.request"));
    expect(frame).not.toBeNull();
    const parsed = JSON.parse(frame as string);
    expect(parsed.type).toBe("message");
    expect(parsed.text).toMatch(/approval/i);
  });

  it("drops events the phone does not render", () => {
    for (const type of [
      "tool.start",
      "thinking.delta",
      "status.update",
      "gateway.ready",
    ] as const) {
      expect(agentEventToRemoteFrame(event(type, { text: "x" }))).toBeNull();
    }
  });
});
