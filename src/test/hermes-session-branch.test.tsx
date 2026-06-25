import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BranchFromHereAction } from "../components/agent/AgentWorkspace";
import { createHermesMethods } from "../lib/hermes-control-plane";
import {
  isBranchableMessageId,
  parseBranchSessionResult,
} from "../lib/hermes-session-branch";
import branchFixture from "../lib/hermes-control-plane/fixtures/branch.json";

describe("parseBranchSessionResult", () => {
  it("reads the authoritative new session id from new_session_id", () => {
    const frame = branchFixture.frames[0];
    const result = parseBranchSessionResult(frame.payload, {
      sourceSessionId: frame.session_id,
    });
    // The fork's id is the gateway's, never invented locally.
    expect(result?.sessionId).toBe("sess-branch-fork");
    expect(result?.sourceSessionId).toBe("sess-branch");
    expect(result?.sourceMessageId).toBe("m-3");
  });

  it("accepts session_id / sessionId / nested session as the new id", () => {
    expect(
      parseBranchSessionResult(
        { session_id: "fork-a" },
        { sourceSessionId: "src" },
      )?.sessionId,
    ).toBe("fork-a");
    expect(
      parseBranchSessionResult(
        { sessionId: "fork-b" },
        { sourceSessionId: "src" },
      )?.sessionId,
    ).toBe("fork-b");
    expect(
      parseBranchSessionResult(
        { session: { id: "fork-c" } },
        { sourceSessionId: "src" },
      )?.sessionId,
    ).toBe("fork-c");
  });

  it("falls back to the caller's source session id when the result omits it", () => {
    const result = parseBranchSessionResult(
      { new_session_id: "fork" },
      { sourceSessionId: "caller-src", sourceMessageId: "m-9" },
    );
    expect(result?.sessionId).toBe("fork");
    expect(result?.sourceSessionId).toBe("caller-src");
    expect(result?.sourceMessageId).toBe("m-9");
  });

  it("prefers the result's own source ids over the fallback", () => {
    const result = parseBranchSessionResult(
      {
        new_session_id: "fork",
        source_session_id: "result-src",
        from_message_id: "m-result",
      },
      { sourceSessionId: "caller-src", sourceMessageId: "m-caller" },
    );
    expect(result?.sourceSessionId).toBe("result-src");
    expect(result?.sourceMessageId).toBe("m-result");
  });

  it("returns undefined when no usable new session id is present", () => {
    expect(
      parseBranchSessionResult(null, { sourceSessionId: "src" }),
    ).toBeUndefined();
    expect(
      parseBranchSessionResult({}, { sourceSessionId: "src" }),
    ).toBeUndefined();
    expect(
      parseBranchSessionResult(
        { new_session_id: 42 },
        { sourceSessionId: "src" },
      ),
    ).toBeUndefined();
    expect(
      parseBranchSessionResult("nonsense", { sourceSessionId: "src" }),
    ).toBeUndefined();
  });

  it("never echoes the source id as the new id (a no-op fork is not a fork)", () => {
    // If the gateway returns only the source id, that is not a new session.
    expect(
      parseBranchSessionResult(
        { session_id: "src" },
        { sourceSessionId: "src" },
      ),
    ).toBeUndefined();
  });
});

describe("isBranchableMessageId", () => {
  it("accepts a stable persisted Hermes message id", () => {
    expect(isBranchableMessageId("m-3")).toBe(true);
    expect(isBranchableMessageId("01Happ-ulid-style-id")).toBe(true);
  });

  it("rejects synthetic transcript turn ids (not persisted message ids)", () => {
    // These ids are minted client-side by the turn builder and are NOT valid
    // branch locators — branching from them would fake precision.
    expect(isBranchableMessageId("assistant:2026-06-24T00:00:00Z:2")).toBe(
      false,
    );
    expect(isBranchableMessageId("error:2026-06-24T00:00:00Z")).toBe(false);
    expect(isBranchableMessageId("pending:user:1719190000000")).toBe(false);
  });

  it("rejects empty / whitespace / non-string ids", () => {
    expect(isBranchableMessageId("")).toBe(false);
    expect(isBranchableMessageId("   ")).toBe(false);
    expect(isBranchableMessageId(undefined)).toBe(false);
  });
});

describe("BranchFromHereAction", () => {
  it("sends session.branch with the session and from_message_id when clicked", async () => {
    const request = vi.fn().mockResolvedValue({
      new_session_id: "sess-fork",
      title: "Alternative approach",
    });
    const methods = createHermesMethods(request);
    const onBranch = vi.fn((messageId: string) =>
      methods.branchSession({ sessionId: "sess-1", fromMessageId: messageId }),
    );

    render(<BranchFromHereAction messageId="m-3" onBranch={onBranch} />);
    await userEvent.click(
      screen.getByRole("button", { name: /branch from here/i }),
    );

    expect(onBranch).toHaveBeenCalledWith("m-3");
    expect(request).toHaveBeenCalledWith("session.branch", {
      session_id: "sess-1",
      from_message_id: "m-3",
    });
  });

  it("disables the action and explains why when message identity is insufficient", () => {
    const onBranch = vi.fn();
    render(
      <BranchFromHereAction
        messageId="assistant:2026-06-24T00:00:00Z:2"
        onBranch={onBranch}
      />,
    );
    const button = screen.getByRole("button", { name: /branch from here/i });
    expect(button).toBeDisabled();
    // The title/explanation makes the gating honest rather than silent.
    expect(button).toHaveAttribute(
      "title",
      expect.stringMatching(/available once the message is saved/i),
    );
  });

  it("shows a spinning/disabled state while a branch is in flight", () => {
    const onBranch = vi.fn();
    render(
      <BranchFromHereAction messageId="m-3" onBranch={onBranch} submitting />,
    );
    expect(
      screen.getByRole("button", { name: /branch from here/i }),
    ).toBeDisabled();
  });
});
