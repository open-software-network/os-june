import { beforeEach, describe, expect, it } from "vitest";
import {
  ATTACHMENT_FOLLOW_UP_PROMPT,
  loadQueuedAgentFollowUps,
  reconcileConsumedAgentFollowUp,
  saveQueuedAgentFollowUps,
} from "../lib/agent-follow-up-queue";

const queued = {
  "session-1": {
    messageId: "message-1",
    prompt: "Continue with the attachment",
    attachments: ["/tmp/brief.pdf"],
    model: "open-software/auto",
    thinkingLevel: "medium" as const,
    delivery: "follow_up" as const,
    steering: "accepted" as const,
  },
};

describe("agent follow-up queue", () => {
  beforeEach(() => window.localStorage.clear());

  it("survives a workspace remount", () => {
    saveQueuedAgentFollowUps(queued);
    expect(loadQueuedAgentFollowUps()).toEqual(queued);
  });

  it("drops a fallback once persisted history proves steering consumed it", () => {
    const textOnly = {
      "session-1": {
        ...queued["session-1"],
        attachments: [],
      },
    };
    expect(reconcileConsumedAgentFollowUp(textOnly, "session-1", ["steering:message-1"])).toEqual(
      {},
    );
    expect(reconcileConsumedAgentFollowUp(textOnly, "session-1", ["steering:other"])).toBe(
      textOnly,
    );
  });

  it("keeps pending attachments after steering consumes the text", () => {
    expect(reconcileConsumedAgentFollowUp(queued, "session-1", ["steering:message-1"])).toEqual({
      "session-1": {
        messageId: "message-1",
        prompt: ATTACHMENT_FOLLOW_UP_PROMPT,
        attachments: ["/tmp/brief.pdf"],
        model: "open-software/auto",
        thinkingLevel: "medium",
        delivery: "attachments",
      },
    });
    expect(reconcileConsumedAgentFollowUp(queued, "session-1", ["steering:other"])).toBe(queued);
  });

  it("ignores malformed stored entries", () => {
    window.localStorage.setItem(
      "june.agent.queuedFollowUps",
      JSON.stringify({ valid: queued["session-1"], invalid: { prompt: 42 } }),
    );
    expect(loadQueuedAgentFollowUps()).toEqual({ valid: queued["session-1"] });
  });
});
