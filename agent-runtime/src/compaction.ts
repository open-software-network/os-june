import type { RuntimeHistoryItem } from "./types.js";

export type CompactionResult = {
  history: RuntimeHistoryItem[];
  compacted: boolean;
  removedItemIds: string[];
  summary?: RuntimeHistoryItem;
  estimatedTokens: number;
};

export type HistorySummarizer = (items: RuntimeHistoryItem[]) => Promise<string>;

const DEFAULT_OUTPUT_RESERVE = 4_096;
const MIN_RECENT_GROUPS = 6;

export async function compactHistory(input: {
  history: RuntimeHistoryItem[];
  contextWindow: number;
  maxOutputTokens?: number;
  summarize?: HistorySummarizer;
  force?: boolean;
}): Promise<CompactionResult> {
  const budget = Math.max(1_024, input.contextWindow - (input.maxOutputTokens ?? DEFAULT_OUTPUT_RESERVE));
  const estimatedTokens = estimateHistoryTokens(input.history);
  if (!input.force && estimatedTokens <= budget * 0.85) {
    return { history: input.history, compacted: false, removedItemIds: [], estimatedTokens };
  }

  // A context summary is represented as a system message for inference, but it
  // is replaceable conversation state rather than an immutable instruction.
  // Keeping every prior summary in `system` made repeated compactions grow the
  // prompt forever. Preserve only real system instructions and fold any prior
  // summary back into the next summary.
  const system = input.history.filter(
    (item) => item.role === "system" && item.kind !== "context_summary",
  );
  const priorSummaries = input.history.filter((item) => item.kind === "context_summary");
  const conversation = input.history.filter(
    (item) => item.role !== "system" && item.kind !== "context_summary",
  );
  const groups = groupHistory(conversation);
  const recent = groups.slice(-MIN_RECENT_GROUPS);
  const candidates = [
    ...(priorSummaries.length > 0 ? [priorSummaries] : []),
    ...groups.slice(0, Math.max(0, groups.length - MIN_RECENT_GROUPS)),
  ];
  // Six groups is a preference, not a hard exemption. A single bounded tool
  // result can still exceed a small model's context window, so progressively
  // fold the oldest recent groups into the summary until the retained prompt
  // leaves room for both the summary and model output.
  while (
    recent.length > 0 &&
    estimateHistoryTokens([...system, ...recent.flat()]) > budget * 0.75
  ) {
    const oldest = recent.shift();
    if (oldest) candidates.push(oldest);
  }
  if (candidates.length === 0) {
    return { history: input.history, compacted: false, removedItemIds: [], estimatedTokens };
  }

  const removed = candidates.flat();
  const unboundedSummary = await summarizeOrFallback(removed, input.summarize);
  const maxSummaryChars = Math.max(1_000, Math.floor(budget * 4 * 0.25));
  const summaryText =
    unboundedSummary.length > maxSummaryChars
      ? `${unboundedSummary.slice(0, maxSummaryChars)}\n[summary truncated]`
      : unboundedSummary;
  const summary: RuntimeHistoryItem = {
    id: `context-summary-${Date.now()}`,
    kind: "context_summary",
    role: "system",
    text: summaryText,
    estimatedTokens: estimateTextTokens(summaryText),
  };
  const history = [...system, summary, ...recent.flat()];
  return {
    history,
    compacted: true,
    removedItemIds: removed.map((item) => item.id),
    summary,
    estimatedTokens: estimateHistoryTokens(history),
  };
}

export function estimateHistoryTokens(history: RuntimeHistoryItem[]): number {
  return history.reduce(
    (total, item) => total + (item.estimatedTokens ?? estimateTextTokens(item.text ?? JSON.stringify(item.payload ?? ""))) + 8,
    0,
  );
}

function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function groupHistory(history: RuntimeHistoryItem[]): RuntimeHistoryItem[][] {
  const groups: RuntimeHistoryItem[][] = [];
  const indexes = new Map<string, number>();
  for (const item of history) {
    const key = item.groupId ?? item.callId ?? item.id;
    const existing = indexes.get(key);
    if (existing === undefined) {
      indexes.set(key, groups.length);
      groups.push([item]);
    } else {
      groups[existing]?.push(item);
    }
  }
  return groups;
}

async function summarizeOrFallback(
  items: RuntimeHistoryItem[],
  summarize?: HistorySummarizer,
): Promise<string> {
  if (summarize) {
    try {
      const summary = (await summarize(items)).trim();
      if (summary) return summary;
    } catch {
      // The model route owns its request timeout. Any model or transport
      // failure must leave compaction available through the bounded fallback.
    }
  }
  return formatHistoryForSummary(items);
}

export function formatHistoryForSummary(
  items: RuntimeHistoryItem[],
  maxChars = 12_000,
): string {
  const lines = items
    .map((item) => summaryLine(item))
    .filter((line): line is string => Boolean(line))
    .join("\n");
  const bounded = lines.slice(0, maxChars);
  return `Earlier conversation context:\n${bounded}${lines.length > bounded.length ? "\n[older context truncated]" : ""}`;
}

function summaryLine(item: RuntimeHistoryItem): string | undefined {
  if (item.text) return `${item.role ?? item.kind}: ${item.text}`;
  if (item.kind !== "tool_call" && item.kind !== "tool_result") return undefined;
  const identity = [item.name, item.callId].filter(Boolean).join(" ");
  const payload = boundedJson(item.payload, 4_000);
  return `${item.kind}${identity ? ` ${identity}` : ""}: ${payload}`;
}

function boundedJson(value: RuntimeHistoryItem["payload"], maxChars: number): string {
  if (value === undefined) return "[no payload]";
  const serialized = JSON.stringify(value);
  return serialized.length > maxChars
    ? `${serialized.slice(0, maxChars)}[payload truncated]`
    : serialized;
}
