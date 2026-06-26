import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  parseCompressSessionResult,
  type CompressSessionResult,
} from "../lib/hermes-session-compress";
import { createHermesMethods } from "../lib/hermes-control-plane";
import { HermesGatewayError } from "../lib/hermes-gateway";
import { SessionCompactDialog } from "../components/agent/AgentWorkspace";

// A full compress result as the gateway might return it, mixing snake_case and
// a nested usage block so the parser is exercised on realistic wire data.
const FULL_RAW = {
  session_id: "sess-1",
  usage: { before_tokens: 120_000, after_tokens: 18_000 },
  summary_message_id: "msg-summary-1",
};

describe("parseCompressSessionResult", () => {
  it("normalizes a full snake_case payload", () => {
    const result = parseCompressSessionResult("sess-1", FULL_RAW);
    expect(result.sessionId).toBe("sess-1");
    expect(result.beforeTokens).toBe(120_000);
    expect(result.afterTokens).toBe(18_000);
    expect(result.summaryMessageId).toBe("msg-summary-1");
    expect(result.raw).toBe(FULL_RAW);
  });

  it("tolerates camelCase keys and root-level tokens", () => {
    const result = parseCompressSessionResult("sess-2", {
      beforeTokens: 1000,
      afterTokens: 250,
      summaryMessageId: "m-2",
    });
    expect(result.beforeTokens).toBe(1000);
    expect(result.afterTokens).toBe(250);
    expect(result.summaryMessageId).toBe("m-2");
  });

  it("leaves missing fields undefined on a partial payload", () => {
    const result = parseCompressSessionResult("sess-3", {
      summary_message_id: "only-id",
    });
    expect(result.sessionId).toBe("sess-3");
    expect(result.beforeTokens).toBeUndefined();
    expect(result.afterTokens).toBeUndefined();
    expect(result.summaryMessageId).toBe("only-id");
  });

  it("never throws on junk input and keeps numeric fields undefined", () => {
    for (const junk of [null, undefined, 42, "nope", [], { usage: "weird" }]) {
      const result = parseCompressSessionResult("sess-x", junk);
      expect(result.sessionId).toBe("sess-x");
      expect(result.beforeTokens).toBeUndefined();
      expect(result.afterTokens).toBeUndefined();
      expect(result.summaryMessageId).toBeUndefined();
    }
  });

  it("ignores non-finite / non-numeric numeric fields", () => {
    const result = parseCompressSessionResult("sess-4", {
      before_tokens: "120000",
      after_tokens: Number.NaN,
    });
    expect(result.beforeTokens).toBeUndefined();
    expect(result.afterTokens).toBeUndefined();
  });
});

/** A compress fn that routes through the real typed wrapper so the test also
 * asserts `session.compress` is the method called with the right params. */
function compressVia(request: ReturnType<typeof vi.fn>) {
  const methods = createHermesMethods(request);
  return vi.fn(
    async (sessionId: string): Promise<CompressSessionResult> =>
      parseCompressSessionResult(
        sessionId,
        await methods.compressSession({ sessionId }),
      ),
  );
}

describe("SessionCompactDialog", () => {
  it("explains compaction honestly before compressing and does not call session.compress on open", () => {
    const request = vi.fn().mockResolvedValue(FULL_RAW);
    const compress = compressVia(request);
    render(
      <SessionCompactDialog
        open
        sessionId="sess-1"
        compress={compress}
        onClose={() => {}}
      />,
    );

    // Explanatory copy is present and honest: it does not promise the original
    // transcript is preserved.
    expect(screen.getByText(/smaller working memory/i)).toBeInTheDocument();
    expect(
      screen.getByText(/older messages may be summarized/i),
    ).toBeInTheDocument();

    // Nothing is compressed merely by opening the confirmation.
    expect(compress).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("cancel closes without compressing (confirmation prevents accidental compaction)", async () => {
    const request = vi.fn().mockResolvedValue(FULL_RAW);
    const compress = compressVia(request);
    const onClose = vi.fn();
    render(
      <SessionCompactDialog
        open
        sessionId="sess-1"
        compress={compress}
        onClose={onClose}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(compress).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("confirming calls session.compress exactly once and shows a success item", async () => {
    const request = vi.fn().mockResolvedValue(FULL_RAW);
    const compress = compressVia(request);
    render(
      <SessionCompactDialog
        open
        sessionId="sess-1"
        compress={compress}
        onClose={() => {}}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /compact context/i }),
    );

    await waitFor(() => expect(compress).toHaveBeenCalledTimes(1));
    expect(compress).toHaveBeenCalledWith("sess-1");
    // Routed through the typed wrapper to the right gateway method, once.
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("session.compress", {
      session_id: "sess-1",
    });

    // A visible "Context compacted" success item appears.
    expect(await screen.findByText(/context compacted/i)).toBeInTheDocument();
  });

  it("renders token savings when the result reports before/after tokens", async () => {
    const request = vi.fn().mockResolvedValue(FULL_RAW);
    const compress = compressVia(request);
    render(
      <SessionCompactDialog
        open
        sessionId="sess-1"
        compress={compress}
        onClose={() => {}}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /compact context/i }),
    );

    // Both endpoints render (grouped formatting tolerated).
    expect(await screen.findByText(/120,?000/)).toBeInTheDocument();
    expect(screen.getByText(/18,?000/)).toBeInTheDocument();
  });

  it("still shows success when the result has no token metrics", async () => {
    const request = vi.fn().mockResolvedValue({});
    const compress = compressVia(request);
    render(
      <SessionCompactDialog
        open
        sessionId="sess-1"
        compress={compress}
        onClose={() => {}}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /compact context/i }),
    );

    // Success is reported even with no savings figures, and no number is faked.
    expect(await screen.findByText(/context compacted/i)).toBeInTheDocument();
  });

  it("shows a clear message and does not crash when the session is busy (4009)", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new HermesGatewayError("session busy", 4009));
    const compress = compressVia(request);
    render(
      <SessionCompactDialog
        open
        sessionId="sess-1"
        compress={compress}
        onClose={() => {}}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /compact context/i }),
    );

    // A clear, busy-specific message — no "Context compacted", no throw.
    expect(await screen.findByText(/running/i)).toBeInTheDocument();
    expect(screen.queryByText(/context compacted/i)).not.toBeInTheDocument();
  });

  it("shows a clear message on a generic rejection without crashing", async () => {
    const request = vi.fn().mockRejectedValue(new Error("nope"));
    const compress = compressVia(request);
    render(
      <SessionCompactDialog
        open
        sessionId="sess-1"
        compress={compress}
        onClose={() => {}}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /compact context/i }),
    );

    expect(
      await screen.findByText(/couldn't compact|could not compact/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/context compacted/i)).not.toBeInTheDocument();
  });
});
