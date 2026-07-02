import { describe, expect, it } from "vitest";
import { buildAgentChatTurns } from "../lib/agent-chat-runtime";
import type { JuneHermesEvent } from "../lib/hermes-control-plane";

const SECRET_VALUE_PLACEHOLDER = "sk-FAKE-PLACEHOLDER-secret-value-do-not-use-0000000000";

function pendingAction(event: Extract<JuneHermesEvent, { kind: "pending_action" }>) {
  return event;
}

function pendingActionResolution(
  event: Extract<JuneHermesEvent, { kind: "pending_action_resolution" }>,
) {
  return event;
}

describe("Hermes sudo pending action — runtime", () => {
  it("renders a live sudo.request as a pending sudo chat part", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        pendingAction({
          kind: "pending_action",
          sessionId: "sess-sudo",
          receivedAt: "2026-06-04T10:00:00.000Z",
          action: {
            kind: "sudo",
            requestId: "su-1",
            command: "apt-get install ripgrep",
            reason: "ripgrep is required to search the dependency tree",
            mode: "unrestricted",
          },
        }),
      ],
    );

    expect(turns[0]?.parts).toEqual([
      {
        type: "sudo",
        id: "su-1",
        sessionId: "sess-sudo",
        command: "apt-get install ripgrep",
        reason: "ripgrep is required to search the dependency tree",
        mode: "unrestricted",
        status: "pending",
      },
    ]);
  });

  it("marks a sudo request resolved after a sudo.response", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        pendingAction({
          kind: "pending_action",
          sessionId: "sess-sudo",
          receivedAt: "2026-06-04T10:00:00.000Z",
          action: {
            kind: "sudo",
            requestId: "su-1",
            command: "apt-get install ripgrep",
            reason: "ripgrep is required to search the dependency tree",
            mode: "unrestricted",
          },
        }),
        pendingActionResolution({
          kind: "pending_action_resolution",
          sessionId: "sess-sudo",
          receivedAt: "2026-06-04T10:00:01.000Z",
          action: {
            kind: "sudo",
            requestId: "su-1",
            mode: "unrestricted",
            granted: true,
          },
        }),
      ],
    );

    const part = turns[0]?.parts[0];
    expect(part).toMatchObject({
      type: "sudo",
      id: "su-1",
      status: "resolved",
      approved: true,
    });
  });

  it("degrades gracefully when the sudo payload omits command and reason", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        pendingAction({
          kind: "pending_action",
          sessionId: "",
          receivedAt: "2026-06-04T10:00:00.000Z",
          action: {
            kind: "sudo",
            requestId: "su-bare",
          },
        }),
      ],
    );

    // No command/reason text → still a pending, actionable card (no crash, no
    // dropped turn).
    expect(turns[0]?.parts).toEqual([
      {
        type: "sudo",
        id: "su-bare",
        status: "pending",
      },
    ]);
  });
});

describe("Hermes secret pending action — runtime", () => {
  it("renders a live secret.request as a pending secret chat part with metadata only", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        pendingAction({
          kind: "pending_action",
          sessionId: "sess-secret",
          receivedAt: "2026-06-04T10:00:00.000Z",
          action: {
            kind: "secret",
            requestId: "se-1",
            keyName: "OPENAI_API_KEY",
            reason: "Needed to call the OpenAI API on your behalf",
            redacted: true,
          },
        }),
      ],
    );

    expect(turns[0]?.parts).toEqual([
      {
        type: "secret",
        id: "se-1",
        sessionId: "sess-secret",
        keyName: "OPENAI_API_KEY",
        reason: "Needed to call the OpenAI API on your behalf",
        status: "pending",
      },
    ]);
  });

  it("never carries the secret value onto the part even when the gateway leaks it", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        pendingAction({
          kind: "pending_action",
          sessionId: "sess-secret",
          receivedAt: "2026-06-04T10:00:00.000Z",
          action: {
            kind: "secret",
            requestId: "se-1",
            keyName: "OPENAI_API_KEY",
            reason: "Needed to call the OpenAI API on your behalf",
            redacted: true,
          },
        }),
      ],
    );

    // The whole serialized turn tree must be free of the leaked value.
    const serialized = JSON.stringify(turns);
    expect(serialized).not.toContain(SECRET_VALUE_PLACEHOLDER);
    expect(serialized).not.toContain("sk-");
  });

  it("marks a secret request resolved after a secret.response without echoing the value", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        pendingAction({
          kind: "pending_action",
          sessionId: "sess-secret",
          receivedAt: "2026-06-04T10:00:00.000Z",
          action: {
            kind: "secret",
            requestId: "se-1",
            keyName: "OPENAI_API_KEY",
            reason: "Needed to call the OpenAI API on your behalf",
            redacted: true,
          },
        }),
        pendingActionResolution({
          kind: "pending_action_resolution",
          sessionId: "sess-secret",
          receivedAt: "2026-06-04T10:00:01.000Z",
          action: {
            kind: "secret",
            requestId: "se-1",
            redacted: true,
          },
        }),
      ],
    );

    const part = turns[0]?.parts[0];
    expect(part).toMatchObject({
      type: "secret",
      id: "se-1",
      status: "resolved",
    });
    expect(JSON.stringify(part)).not.toContain(SECRET_VALUE_PLACEHOLDER);
  });
});
