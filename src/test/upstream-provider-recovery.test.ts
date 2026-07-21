import { describe, expect, it, vi } from "vitest";
import type { AgentChatTurn } from "../lib/agent-chat-runtime";
import {
  UPSTREAM_PROVIDER_FAILURE_RETRY_PROMPT,
  createUpstreamProviderRecoveryStore,
  displayedUpstreamProviderRecoveryPreview,
  upstreamProviderRecoveryIds,
} from "../lib/upstream-provider-recovery";

function providerFailure(id: string): AgentChatTurn {
  return {
    id,
    role: "assistant",
    createdAt: "2026-07-21T08:00:00.000Z",
    status: "complete",
    parts: [
      {
        type: "notice",
        kind: "upstream-provider",
        text: "June's service is temporarily unavailable. Your message is saved.",
      },
    ],
  };
}

describe("upstream-provider recovery", () => {
  it("replaces any truncation of the recovery prompt in previews, but not a quote that diverges", () => {
    expect(displayedUpstreamProviderRecoveryPreview(UPSTREAM_PROVIDER_FAILURE_RETRY_PROMPT)).toBe(
      "Try again",
    );
    // Hermes may cut the preview at any point inside the prompt.
    expect(
      displayedUpstreamProviderRecoveryPreview(UPSTREAM_PROVIDER_FAILURE_RETRY_PROMPT.slice(0, 48)),
    ).toBe("Try again");
    expect(displayedUpstreamProviderRecoveryPreview("[June upstream provider recovery]")).toBe(
      "Try again",
    );
    // A user message that quotes the opener and then diverges is the user's
    // own text and must stay visible.
    const quote = "[June upstream provider recovery] is what June sends, right?";
    expect(displayedUpstreamProviderRecoveryPreview(quote)).toBe(quote);
    expect(displayedUpstreamProviderRecoveryPreview(undefined)).toBeUndefined();
    expect(displayedUpstreamProviderRecoveryPreview("   ")).toBe("   ");
  });

  it("uses failure order rather than surface-local turn ids", () => {
    const workspaceIds = upstreamProviderRecoveryIds([
      providerFailure("assistant:workspace-time:1"),
      providerFailure("assistant:workspace-time:2"),
    ]);
    const noteChatIds = upstreamProviderRecoveryIds([
      providerFailure("assistant:note-chat-time:1"),
      providerFailure("assistant:note-chat-time:2"),
    ]);

    expect([...workspaceIds.values()]).toEqual(["upstream-provider:1", "upstream-provider:2"]);
    expect([...noteChatIds.values()]).toEqual([...workspaceIds.values()]);
  });

  it("reserves one process-local attempt and can release a rejected submit", () => {
    const store = createUpstreamProviderRecoveryStore();
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.reserve("stored-session", "upstream-provider:1")).toBe(true);
    expect(store.reserve("stored-session", "upstream-provider:1")).toBe(false);
    expect(store.attempted("stored-session", "upstream-provider:1")).toBe(true);
    expect(listener).toHaveBeenCalledOnce();

    store.release("stored-session", "upstream-provider:1");
    expect(store.attempted("stored-session", "upstream-provider:1")).toBe(false);
    expect(store.reserve("stored-session", "upstream-provider:1")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
