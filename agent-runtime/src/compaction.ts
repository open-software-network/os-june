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
}): Promise<CompactionResult> {
  const budget = Math.max(1_024, input.contextWindow - (input.maxOutputTokens ?? DEFAULT_OUTPUT_RESERVE));
  const estimatedTokens = estimateHistoryTokens(input.history);
  if (estimatedTokens <= budget * 0.85) {
    return { history: input.history, compacted: false, removedItemIds: [], estimatedTokens };
  }

  const system = input.history.filter((item) => item.role === "system");
  const nonSystem = input.history.filter((item) => item.role !== "system");
  const groups = groupHistory(nonSystem);
  const recent = groups.slice(-MIN_RECENT_GROUPS);
  const candidates = groups.slice(0, Math.max(0, groups.length - MIN_RECENT_GROUPS));
  if (candidates.length === 0) {
    return { history: input.history, compacted: false, removedItemIds: [], estimatedTokens };
  }

  const removed = candidates.flat();
  const summaryText = input.summarize
    ? await input.summarize(removed)
    : deterministicSummary(removed);
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

function deterministicSummary(items: RuntimeHistoryItem[]): string {
  const lines = items
    .filter((item) => item.text)
    .map((item) => `${item.role ?? item.kind}: ${item.text}`)
    .join("\n");
  const bounded = lines.slice(0, 12_000);
  return `Earlier conversation context:\n${bounded}${lines.length > bounded.length ? "\n[older context truncated]" : ""}`;
}
