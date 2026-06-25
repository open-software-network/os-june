/**
 * Normalized session usage — the typed shape feature 09's usage/context/cost
 * panel renders, parsed defensively from the raw `session.usage` result.
 *
 * The gateway's `methods.getSessionUsage(...)` resolves to `unknown`: Hermes can
 * add, rename, or drop usage fields between pins, and providers report tokens
 * under different keys. So this module owns the ONE place that turns that raw
 * blob into {@link SessionUsage}. Every field is optional and stays `undefined`
 * when absent or malformed; the parser tolerates both snake_case and camelCase
 * and never throws on junk. The UI degrades each missing field to "Unavailable"
 * rather than guessing.
 *
 * Reusable by feature 11 (activity drawer): the drawer can call the same parser
 * and render {@link import("../components/agent/SessionUsagePanel").SessionUsagePanel}
 * as a tab.
 */

import {
  asRecord,
  finiteNumber,
  pickNumber,
  pickString,
} from "./hermes-control-plane";

/** A single tool or subagent cost line, when the gateway breaks costs down. */
export type SessionToolCost = {
  name: string;
  estimatedCostUsd?: number;
};

/** Normalized, UI-ready usage for one session. All metrics optional: a field is
 * present only when the gateway reported a usable value. */
export type SessionUsage = {
  sessionId: string;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  contextUsed?: number;
  contextLimit?: number;
  estimatedCostUsd?: number;
  /** Per-tool / per-subagent cost breakdown, when returned. */
  toolCosts?: SessionToolCost[];
  /** The untouched gateway result, kept for the trace panel / debugging. */
  raw?: unknown;
};

function parseToolCosts(value: unknown): SessionToolCost[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const costs: SessionToolCost[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const name =
      pickString([record], ["name", "tool", "tool_name", "label"]) ?? undefined;
    if (!name) continue;
    costs.push({
      name,
      estimatedCostUsd: pickNumber(
        [record],
        ["estimated_cost_usd", "estimatedCostUsd", "cost_usd", "costUsd"],
      ),
    });
  }
  return costs.length > 0 ? costs : undefined;
}

/**
 * Parse a raw `session.usage` result into a {@link SessionUsage}. Defensive by
 * design: unknown shape in, normalized shape out, missing/malformed fields left
 * `undefined`. `sessionId` is always carried through from the caller so the
 * panel can label which session it describes even when the payload omits it.
 */
export function parseSessionUsage(
  sessionId: string,
  raw: unknown,
): SessionUsage {
  const root = asRecord(raw);
  // Tokens may live at the root or under a `usage` / `tokens` sub-object.
  const usage = asRecord(root?.usage) ?? asRecord(root?.tokens);
  // Context may live at the root or under a `context` sub-object.
  const context = asRecord(root?.context);

  const tokenContainers = [usage, root];
  const contextContainers = [context, root];

  return {
    sessionId,
    provider: pickString([root], ["provider", "provider_name", "vendor"]),
    model: pickString([root], ["model", "model_name", "model_id", "modelId"]),
    // Each list ends with Hermes's own `SessionUsageResponse` names
    // (input/output/total, context_used/context_max) so the live gateway's
    // shape is read directly, not just the generic OpenAI-style aliases.
    promptTokens: pickNumber(tokenContainers, [
      "prompt_tokens",
      "promptTokens",
      "input_tokens",
      "inputTokens",
      "input",
    ]),
    completionTokens: pickNumber(tokenContainers, [
      "completion_tokens",
      "completionTokens",
      "output_tokens",
      "outputTokens",
      "output",
    ]),
    totalTokens: pickNumber(tokenContainers, [
      "total_tokens",
      "totalTokens",
      "total",
    ]),
    contextUsed: pickNumber(contextContainers, [
      "used",
      "context_used",
      "contextUsed",
      "used_tokens",
    ]),
    contextLimit: pickNumber(contextContainers, [
      "limit",
      "context_limit",
      "contextLimit",
      "context_max",
      "max_tokens",
      "maxTokens",
      "window",
    ]),
    estimatedCostUsd: pickNumber(
      [root],
      ["estimated_cost_usd", "estimatedCostUsd", "cost_usd", "costUsd"],
    ),
    toolCosts: parseToolCosts(
      root?.tool_costs ?? root?.toolCosts ?? root?.tools,
    ),
    raw,
  };
}
