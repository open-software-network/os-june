import type { RuntimeHistoryItem } from "./types.js";

export type CompactionResult = {
  history: RuntimeHistoryItem[];
  compacted: boolean;
  removedItemIds: string[];
  summary?: RuntimeHistoryItem;
  estimatedTokens: number;
};

export type HistorySummarizer = (items: RuntimeHistoryItem[]) => Promise<string>;
export type CompactionFallbackHandler = (error: unknown) => void;

const DEFAULT_OUTPUT_RESERVE = 4_096;
const MIN_RECENT_GROUPS = 6;

export async function compactHistory(input: {
  history: RuntimeHistoryItem[];
  contextWindow: number;
  maxOutputTokens?: number;
  summarize?: HistorySummarizer;
  onFallback?: CompactionFallbackHandler;
  force?: boolean;
}): Promise<CompactionResult> {
  const budget = Math.max(1_024, input.contextWindow - (input.maxOutputTokens ?? DEFAULT_OUTPUT_RESERVE));
  const estimatedTokens = estimateHistoryTokens(input.history);
  if (!input.force && estimatedTokens <= budget * 0.85) {
    return { history: input.history, compacted: false, removedItemIds: [], estimatedTokens };
  }

  // A context summary is replaceable conversation state, never an immutable
  // instruction. Preserve only real system instructions and fold any prior
  // summary back into the next summary so repeated compactions stay bounded.
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
  const summaryResult = await summarizeOrFallback(
    removed,
    input.summarize,
    input.onFallback,
  );
  const unboundedSummary = summaryResult.text;
  const maxSummaryChars = Math.max(1_000, Math.floor(budget * 4 * 0.25));
  const summaryText = summaryResult.fallback
    ? formatHistoryForSummary(removed, maxSummaryChars)
    : unboundedSummary.length > maxSummaryChars
      ? `${unboundedSummary.slice(0, maxSummaryChars)}\n[summary truncated]`
      : unboundedSummary;
  const summary: RuntimeHistoryItem = {
    id: `context-summary-${Date.now()}`,
    kind: "context_summary",
    role: "user",
    text: summaryText,
    metadata: { fallback: summaryResult.fallback },
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
  onFallback?: CompactionFallbackHandler,
): Promise<{ text: string; fallback: boolean }> {
  if (summarize) {
    try {
      const summary = (await summarize(items)).trim();
      if (summary) return { text: summary, fallback: false };
      const error = new Error("Clovy model route returned an empty context summary");
      onFallback?.(error);
    } catch (error) {
      if (isAbortError(error)) throw error;
      onFallback?.(error);
    }
  } else {
    onFallback?.(new Error("No model summarizer was configured"));
  }
  return { text: formatHistoryForSummary(items), fallback: true };
}

export function formatHistoryForSummary(
  items: RuntimeHistoryItem[],
  maxChars = 12_000,
): string {
  const lines = items
    .map((item) => summaryLine(item))
    .filter((line): line is string => Boolean(line))
    .join("\n");
  if (lines.length <= maxChars) return `Earlier conversation context:\n${lines}`;
  return `Earlier conversation context:\n[earlier context truncated]\n${lines.slice(-maxChars)}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
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
