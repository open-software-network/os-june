import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  parseSessionUsage,
  type SessionUsage,
} from "../lib/hermes-session-usage";
import { SessionUsagePanel } from "../components/agent/SessionUsagePanel";

// A full usage payload as the gateway might return it. Mixes snake_case and a
// nested tool-cost breakdown so the parser is exercised on realistic wire data.
const FULL_RAW = {
  session_id: "sess-1",
  provider: "anthropic",
  model: "claude-opus-4",
  usage: {
    prompt_tokens: 1200,
    completion_tokens: 800,
    total_tokens: 2000,
  },
  context: { used: 18000, limit: 200000 },
  estimated_cost_usd: 0.4213,
  tool_costs: [
    { name: "web_search", estimated_cost_usd: 0.01 },
    { name: "code_subagent", estimated_cost_usd: 0.12 },
  ],
};

describe("parseSessionUsage", () => {
  it("normalizes a full snake_case payload", () => {
    const usage = parseSessionUsage("sess-1", FULL_RAW);
    expect(usage.sessionId).toBe("sess-1");
    expect(usage.provider).toBe("anthropic");
    expect(usage.model).toBe("claude-opus-4");
    expect(usage.promptTokens).toBe(1200);
    expect(usage.completionTokens).toBe(800);
    expect(usage.totalTokens).toBe(2000);
    expect(usage.contextUsed).toBe(18000);
    expect(usage.contextLimit).toBe(200000);
    expect(usage.estimatedCostUsd).toBeCloseTo(0.4213);
    expect(usage.toolCosts).toEqual([
      { name: "web_search", estimatedCostUsd: 0.01 },
      { name: "code_subagent", estimatedCostUsd: 0.12 },
    ]);
    expect(usage.raw).toBe(FULL_RAW);
  });

  it("tolerates camelCase keys", () => {
    const usage = parseSessionUsage("sess-2", {
      provider: "openai",
      model: "gpt-x",
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      contextUsed: 5,
      contextLimit: 100,
      estimatedCostUsd: 1.5,
    });
    expect(usage.promptTokens).toBe(10);
    expect(usage.completionTokens).toBe(20);
    expect(usage.totalTokens).toBe(30);
    expect(usage.contextUsed).toBe(5);
    expect(usage.contextLimit).toBe(100);
    expect(usage.estimatedCostUsd).toBe(1.5);
  });

  it("leaves missing fields undefined on a partial payload", () => {
    const usage = parseSessionUsage("sess-3", { usage: { prompt_tokens: 5 } });
    expect(usage.sessionId).toBe("sess-3");
    expect(usage.promptTokens).toBe(5);
    expect(usage.completionTokens).toBeUndefined();
    expect(usage.totalTokens).toBeUndefined();
    expect(usage.contextUsed).toBeUndefined();
    expect(usage.contextLimit).toBeUndefined();
    expect(usage.estimatedCostUsd).toBeUndefined();
    expect(usage.model).toBeUndefined();
    expect(usage.provider).toBeUndefined();
  });

  it("never throws on junk input and keeps numeric fields undefined", () => {
    for (const junk of [null, undefined, 42, "nope", [], { usage: "weird" }]) {
      const usage = parseSessionUsage("sess-x", junk);
      expect(usage.sessionId).toBe("sess-x");
      expect(usage.promptTokens).toBeUndefined();
      expect(usage.totalTokens).toBeUndefined();
    }
  });

  it("ignores non-finite / non-numeric numeric fields", () => {
    const usage = parseSessionUsage("sess-4", {
      usage: { prompt_tokens: "1200", total_tokens: Number.NaN },
      estimated_cost_usd: "free",
    });
    expect(usage.promptTokens).toBeUndefined();
    expect(usage.totalTokens).toBeUndefined();
    expect(usage.estimatedCostUsd).toBeUndefined();
  });

  it("reads Hermes's flat SessionUsageResponse field names", () => {
    // The live gateway returns input/output/total, context_used/context_max,
    // and cost_usd at the root (no nested usage/context) and omits provider.
    // Regression guard: these aliases must map, or the panel shows "Unavailable".
    const usage = parseSessionUsage("sess-hermes", {
      model: "zai-org-glm-5-2",
      input: 1200,
      output: 800,
      total: 2000,
      context_used: 118000,
      context_max: 128000,
      context_percent: 92,
      cost_usd: 0.21,
      cost_status: "estimated",
    });
    expect(usage.model).toBe("zai-org-glm-5-2");
    expect(usage.promptTokens).toBe(1200);
    expect(usage.completionTokens).toBe(800);
    expect(usage.totalTokens).toBe(2000);
    expect(usage.contextUsed).toBe(118000);
    expect(usage.contextLimit).toBe(128000);
    expect(usage.estimatedCostUsd).toBeCloseTo(0.21);
    expect(usage.provider).toBeUndefined();
  });
});

function fetchUsageFor(raw: unknown) {
  return vi.fn(
    async (sessionId: string): Promise<SessionUsage> =>
      parseSessionUsage(sessionId, raw),
  );
}

describe("SessionUsagePanel", () => {
  it("renders all metrics from a full payload", async () => {
    const fetchUsage = fetchUsageFor(FULL_RAW);
    render(
      <SessionUsagePanel
        sessionId="sess-1"
        fetchUsage={fetchUsage}
        onClose={() => {}}
      />,
    );

    // Resolves once on mount.
    await waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
    expect(fetchUsage).toHaveBeenCalledWith("sess-1");

    expect(await screen.findByText("claude-opus-4")).toBeInTheDocument();
    expect(screen.getByText("anthropic")).toBeInTheDocument();
    // Token counts render (grouped formatting tolerated).
    expect(screen.getByText(/1,?200/)).toBeInTheDocument();
    expect(screen.getByText(/^800$/)).toBeInTheDocument();
    expect(screen.getByText(/2,?000/)).toBeInTheDocument();
    // Tool costs surface by name.
    expect(screen.getByText("web_search")).toBeInTheDocument();
    expect(screen.getByText("code_subagent")).toBeInTheDocument();
  });

  it("labels cost as an estimate, never as exact", async () => {
    const fetchUsage = fetchUsageFor(FULL_RAW);
    render(
      <SessionUsagePanel
        sessionId="sess-1"
        fetchUsage={fetchUsage}
        onClose={() => {}}
      />,
    );
    // The dollar value is present...
    expect(await screen.findByText(/\$0\.42/)).toBeInTheDocument();
    // ...and clearly framed as an estimate (case-insensitive).
    expect(screen.getAllByText(/estimate/i).length).toBeGreaterThan(0);
  });

  it("shows Unavailable for missing fields instead of crashing", async () => {
    const fetchUsage = fetchUsageFor({ usage: { prompt_tokens: 5 } });
    render(
      <SessionUsagePanel
        sessionId="sess-3"
        fetchUsage={fetchUsage}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
    // Prompt tokens still shown.
    expect(await screen.findByText(/^5$/)).toBeInTheDocument();
    // Missing fields degrade to "Unavailable" (sentence case), not a throw.
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
  });

  it("refresh calls session.usage exactly once per click", async () => {
    const fetchUsage = fetchUsageFor(FULL_RAW);
    render(
      <SessionUsagePanel
        sessionId="sess-1"
        fetchUsage={fetchUsage}
        onClose={() => {}}
      />,
    );
    // One fetch on mount.
    await waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(2));
    // Exactly one more call — the click does not fan out.
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("shows model and provider when present", async () => {
    const fetchUsage = fetchUsageFor({ provider: "anthropic", model: "opus" });
    render(
      <SessionUsagePanel
        sessionId="sess-1"
        fetchUsage={fetchUsage}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("opus")).toBeInTheDocument();
    expect(screen.getByText("anthropic")).toBeInTheDocument();
  });
});
