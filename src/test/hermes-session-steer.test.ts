import { describe, expect, it } from "vitest";
import {
  STEER_EVENT_TYPE,
  normalizeSteerText,
  steerErrorNotice,
  steeringLiveEvent,
  steeringPartText,
} from "../lib/hermes-session-steer";
import { HermesGatewayError } from "../lib/hermes-gateway";
import { buildHermesSessionChatTurns } from "../lib/agent-chat-runtime";

describe("normalizeSteerText", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeSteerText("  focus on tests  ")).toBe("focus on tests");
  });

  it("returns undefined for blank or whitespace-only input", () => {
    expect(normalizeSteerText("")).toBeUndefined();
    expect(normalizeSteerText("   \n\t ")).toBeUndefined();
  });

  it("keeps interior whitespace and newlines intact", () => {
    expect(normalizeSteerText("  line one\nline two ")).toBe(
      "line one\nline two",
    );
  });
});

describe("steerErrorNotice", () => {
  it("explains the session is busy on a 4009 rejection without leaking the code", () => {
    const notice = steerErrorNotice(
      new HermesGatewayError("session busy", 4009),
    );
    expect(notice).toMatch(/busy|already working|finish/i);
    expect(notice).not.toMatch(/4009/);
  });

  it("explains a dropped connection when the gateway is disconnected", () => {
    const notice = steerErrorNotice(
      new Error("Hermes bridge did not return a gateway URL."),
    );
    expect(notice).toMatch(/connection|disconnected|reconnect|bridge/i);
  });

  it("falls back to a clear generic instruction-failed message for an unknown rejection", () => {
    const notice = steerErrorNotice(new Error("kaboom"));
    expect(notice).toMatch(/couldn't|could not/i);
    expect(notice).toMatch(/instruction/i);
  });

  it("never returns an empty string", () => {
    for (const err of [null, undefined, 42, "nope", {}, new Error("")]) {
      expect(steerErrorNotice(err).length).toBeGreaterThan(0);
    }
  });

  it("uses no em or en dashes in any copy", () => {
    for (const err of [
      new HermesGatewayError("session busy", 4009),
      new Error("Hermes bridge did not return a gateway URL."),
      new Error("kaboom"),
    ]) {
      expect(steerErrorNotice(err)).not.toMatch(/[—–]/);
    }
  });
});

describe("steeringLiveEvent", () => {
  it("builds a synthetic local event carrying the instruction text and timestamp", () => {
    const event = steeringLiveEvent({
      sessionId: "sess-1",
      text: "focus on tests",
      receivedAt: "2026-06-24T10:00:00.000Z",
    });
    expect(event.type).toBe(STEER_EVENT_TYPE);
    expect(event.session_id).toBe("sess-1");
    expect(event.receivedAt).toBe("2026-06-24T10:00:00.000Z");
    expect(steeringPartText(event.payload)).toBe("focus on tests");
  });
});

describe("steering transcript item via buildHermesSessionChatTurns", () => {
  it("renders a steering system turn from the synthetic live event", () => {
    const event = steeringLiveEvent({
      sessionId: "sess-1",
      text: "prioritize the failing test",
      receivedAt: "2026-06-24T10:00:00.000Z",
    });
    const turns = buildHermesSessionChatTurns([], [event]);
    const steering = turns
      .flatMap((turn) => turn.parts.map((part) => ({ turn, part })))
      .find(({ part }) => part.type === "steering");
    expect(steering).toBeDefined();
    expect(steering?.turn.role).toBe("system");
    expect(steering?.part).toMatchObject({
      type: "steering",
      text: "prioritize the failing test",
    });
  });

  it("orders the steering item by its received timestamp among other turns", () => {
    const event = steeringLiveEvent({
      sessionId: "sess-1",
      text: "switch gears",
      receivedAt: "2026-06-24T10:05:00.000Z",
    });
    const turns = buildHermesSessionChatTurns(
      [
        {
          id: "m1",
          role: "user",
          content: "do the thing",
          timestamp: "2026-06-24T10:00:00.000Z",
        },
      ],
      [event],
    );
    const steeringText = turns
      .flatMap((turn) => turn.parts)
      .filter((part) => part.type === "steering");
    expect(steeringText).toHaveLength(1);
    // The steering turn lands after the earlier user message.
    const order = turns.map((turn) => turn.parts[0]?.type);
    expect(order.at(-1)).toBe("steering");
  });
});
