import { describe, expect, it } from "vitest";
import { buildAgentChatTurns } from "../lib/agent-chat-runtime";
import sudoFixture from "../lib/hermes-control-plane/fixtures/sudo-request-response.json";
import secretFixture from "../lib/hermes-control-plane/fixtures/secret-request-response.json";

// The feature-05 fixtures carry the canonical wire shapes. The secret fixture
// deliberately includes a fake secret value in its request payload; the
// runtime must never surface it on a part.
const SECRET_VALUE_PLACEHOLDER = secretFixture._secretValuePlaceholder;

function liveFrame(
  frame: { type: string; session_id?: string; payload?: unknown },
  receivedAt: string,
) {
  return { ...frame, receivedAt };
}

describe("Hermes sudo pending action — runtime", () => {
  it("renders a live sudo.request as a pending sudo chat part", () => {
    const [request] = sudoFixture.frames;
    const turns = buildAgentChatTurns(
      [],
      [],
      [liveFrame(request, "2026-06-04T10:00:00.000Z")],
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
    const [request, response] = sudoFixture.frames;
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        liveFrame(request, "2026-06-04T10:00:00.000Z"),
        liveFrame(response, "2026-06-04T10:00:01.000Z"),
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
        liveFrame(
          { type: "sudo.request", payload: { request_id: "su-bare" } },
          "2026-06-04T10:00:00.000Z",
        ),
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
    const [request] = secretFixture.frames;
    const turns = buildAgentChatTurns(
      [],
      [],
      [liveFrame(request, "2026-06-04T10:00:00.000Z")],
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
    const [request] = secretFixture.frames;
    const turns = buildAgentChatTurns(
      [],
      [],
      [liveFrame(request, "2026-06-04T10:00:00.000Z")],
    );

    // The whole serialized turn tree must be free of the leaked value.
    const serialized = JSON.stringify(turns);
    expect(serialized).not.toContain(SECRET_VALUE_PLACEHOLDER);
    expect(serialized).not.toContain("sk-");
  });

  it("marks a secret request resolved after a secret.response without echoing the value", () => {
    const [request, response] = secretFixture.frames;
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        liveFrame(request, "2026-06-04T10:00:00.000Z"),
        liveFrame(response, "2026-06-04T10:00:01.000Z"),
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
