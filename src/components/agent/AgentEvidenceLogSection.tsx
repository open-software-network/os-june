import { useMemo, useState } from "react";
import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconBolt } from "central-icons/IconBolt";
import { IconClock } from "central-icons/IconClock";
import { IconConsole } from "central-icons/IconConsole";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconEyeOpen } from "central-icons/IconEyeOpen";
import { IconFileText } from "central-icons/IconFileText";
import { IconHand5Finger } from "central-icons/IconHand5Finger";
import { IconRobot } from "central-icons/IconRobot";
import { toolActivityLabel } from "../../lib/agent-tool-labels";
import type { AgentChatTurn } from "../../lib/agent-chat-runtime";
import type { AgentArtifact } from "../../lib/hermes-artifact-store";
import type { HermesTraceEntry } from "../../lib/hermes-trace-buffer";

const EVIDENCE_ROWS_LIMIT = 50;

export type AgentEvidenceLogRow = {
  id: string;
  timestamp?: string;
  title: string;
  detail?: string;
  kind:
    | "action"
    | "tool"
    | "computer"
    | "file"
    | "pending"
    | "background"
    | "error";
};

export function AgentEvidenceLogSection({
  sessionId,
  traceEntries,
  turns,
  artifacts,
}: {
  sessionId: string | undefined;
  traceEntries: HermesTraceEntry[];
  turns: AgentChatTurn[];
  artifacts: AgentArtifact[];
}) {
  const rows = useMemo(
    () => buildEvidenceLogRows({ traceEntries, turns, artifacts }),
    [traceEntries, turns, artifacts],
  );
  const [copied, setCopied] = useState(false);

  if (!sessionId) return null;

  async function copyRows(): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(rows, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="agent-evidence-section" aria-label="Evidence log">
      <header className="agent-evidence-header">
        <span className="agent-evidence-heading">
          <IconEyeOpen size={14} ariaHidden />
          <span className="agent-evidence-title">Evidence log</span>
          <span className="agent-evidence-count" aria-hidden>
            {rows.length}
          </span>
        </span>
        <button
          type="button"
          className="agent-evidence-copy"
          onClick={() => void copyRows()}
          disabled={rows.length === 0}
        >
          <IconArrowInbox size={13} ariaHidden />
          {copied ? "Copied" : "Copy log"}
        </button>
      </header>
      {rows.length === 0 ? (
        <p className="agent-evidence-empty">
          No evidence recorded for this session yet.
        </p>
      ) : (
        <ol className="agent-evidence-list">
          {rows.map((row) => (
            <EvidenceRow key={row.id} row={row} />
          ))}
        </ol>
      )}
    </section>
  );
}

export function buildEvidenceLogRows({
  traceEntries,
  turns,
  artifacts,
}: {
  traceEntries: HermesTraceEntry[];
  turns: AgentChatTurn[];
  artifacts: AgentArtifact[];
}): AgentEvidenceLogRow[] {
  const traceRows = traceEntries.flatMap(rowFromTraceEntry);
  const traceKeys = new Set(traceRows.map(evidenceRowDedupeKey));
  const turnRows = rowsFromTurns(turns).filter(
    (row) => !traceKeys.has(evidenceRowDedupeKey(row)),
  );
  const artifactRows = artifacts.map(rowFromArtifact);
  return [...traceRows, ...turnRows, ...artifactRows]
    .sort(compareRows)
    .slice(-EVIDENCE_ROWS_LIMIT);
}

function EvidenceRow({ row }: { row: AgentEvidenceLogRow }) {
  return (
    <li className="agent-evidence-row" data-kind={row.kind}>
      <span className="agent-evidence-icon" data-kind={row.kind} aria-hidden>
        {iconForKind(row.kind)}
      </span>
      <span className="agent-evidence-body">
        <span className="agent-evidence-row-title">{row.title}</span>
        {row.detail ? (
          <span className="agent-evidence-row-detail">{row.detail}</span>
        ) : null}
      </span>
      {row.timestamp ? (
        <time className="agent-evidence-time" dateTime={row.timestamp}>
          <IconClock size={11} ariaHidden />
          {formatEvidenceTime(row.timestamp)}
        </time>
      ) : null}
    </li>
  );
}

function rowFromTraceEntry(entry: HermesTraceEntry): AgentEvidenceLogRow[] {
  const payload = parsePayloadPreview(entry.payloadPreview);
  if (entry.direction === "outbound") {
    return [
      {
        id: `trace:${entry.id}`,
        timestamp: entry.observedAt,
        title: titleForOutboundMethod(entry.method),
        detail: detailFromPayload(payload, entry.method),
        kind: "action",
      },
    ];
  }
  if (entry.direction === "error") {
    return [
      {
        id: `trace:${entry.id}`,
        timestamp: entry.observedAt,
        title: "Action failed",
        detail: compactDetail(entry.message),
        kind: "error",
      },
    ];
  }
  if (
    entry.normalizedKind === "transcript" ||
    entry.normalizedKind === "reasoning"
  ) {
    return [];
  }
  if (entry.normalizedKind === "tool") {
    const rawName = firstString(payloadRecords(payload), [
      "name",
      "tool_name",
      "tool",
    ]);
    const label = isComputerUse(rawName, payload, entry)
      ? "Computer use"
      : toolActivityLabel(rawName, payload);
    return [
      {
        id: `trace:${entry.id}`,
        timestamp: entry.observedAt,
        title: toolTitle(label, toolPhase(entry.rawType, payload)),
        detail: detailFromPayload(payload),
        kind: label === "Computer use" ? "computer" : "tool",
      },
    ];
  }
  if (entry.normalizedKind === "pending_action") {
    return [
      {
        id: `trace:${entry.id}`,
        timestamp: entry.observedAt,
        title: titleForPendingAction(entry.rawType),
        detail: detailFromPayload(payload),
        kind: "pending",
      },
    ];
  }
  if (entry.normalizedKind === "background_activity") {
    return [
      {
        id: `trace:${entry.id}`,
        timestamp: entry.observedAt,
        title: titleForBackgroundEvent(entry.rawType),
        detail: detailFromPayload(payload),
        kind: "background",
      },
    ];
  }
  if (entry.normalizedKind === "error") {
    return [
      {
        id: `trace:${entry.id}`,
        timestamp: entry.observedAt,
        title: "Agent reported an error",
        detail: detailFromPayload(payload),
        kind: "error",
      },
    ];
  }
  if (entry.normalizedKind === "lifecycle") {
    return [
      {
        id: `trace:${entry.id}`,
        timestamp: entry.observedAt,
        title: titleForLifecycle(entry.rawType),
        detail: detailFromPayload(payload),
        kind: "action",
      },
    ];
  }
  if (entry.normalizedKind === "unsupported") {
    return [
      {
        id: `trace:${entry.id}`,
        timestamp: entry.observedAt,
        title: "Unrecognized agent event",
        detail: compactDetail(entry.rawType),
        kind: "error",
      },
    ];
  }
  return [];
}

function rowsFromTurns(turns: AgentChatTurn[]): AgentEvidenceLogRow[] {
  const rows: AgentEvidenceLogRow[] = [];
  for (const turn of turns) {
    turn.parts.forEach((part, index) => {
      if (part.type === "tool") {
        rows.push({
          id: `turn:${turn.id}:${index}`,
          timestamp: turn.createdAt,
          title: toolTitle(part.name, part.status),
          detail: compactDetail(part.text),
          kind: isComputerUse(part.name, part.text) ? "computer" : "tool",
        });
      } else if (part.type === "approval") {
        rows.push({
          id: `turn:${turn.id}:${index}`,
          timestamp: turn.createdAt,
          title: "Approval requested",
          detail: compactDetail(part.description || part.command),
          kind: "pending",
        });
      } else if (part.type === "clarify") {
        rows.push({
          id: `turn:${turn.id}:${index}`,
          timestamp: turn.createdAt,
          title: "Clarification requested",
          detail: compactDetail(part.question),
          kind: "pending",
        });
      } else if (part.type === "sudo") {
        rows.push({
          id: `turn:${turn.id}:${index}`,
          timestamp: turn.createdAt,
          title: "Privilege approval requested",
          detail: compactDetail(part.reason || part.command),
          kind: "pending",
        });
      } else if (part.type === "secret") {
        rows.push({
          id: `turn:${turn.id}:${index}`,
          timestamp: turn.createdAt,
          title: "Secret requested",
          detail: compactDetail(part.keyName || part.reason),
          kind: "pending",
        });
      } else if (part.type === "steering") {
        rows.push({
          id: `turn:${turn.id}:${index}`,
          timestamp: turn.createdAt,
          title: "Steering sent",
          detail: compactDetail(part.text),
          kind: "action",
        });
      }
    });
  }
  return rows;
}

function rowFromArtifact(artifact: AgentArtifact): AgentEvidenceLogRow {
  return {
    id: `artifact:${artifact.id}`,
    timestamp: new Date(artifact.createdAt).toISOString(),
    title: `${artifactActionTitle(artifact.action)} ${artifact.displayName ?? artifact.path ?? "file"}`,
    detail: compactDetail(artifact.path),
    kind: "file",
  };
}

function titleForOutboundMethod(method: string | undefined): string {
  switch (method) {
    case "prompt.submit":
      return "Prompt sent";
    case "session.create":
      return "Session created";
    case "session.resume":
      return "Session resumed";
    case "session.steer":
      return "Steering sent";
    case "session.interrupt":
      return "Stop requested";
    case "command.dispatch":
      return "Command sent";
    case "approval.respond":
      return "Approval response sent";
    case "clarify.respond":
      return "Clarification response sent";
    case "sudo.respond":
      return "Privilege response sent";
    case "secret.respond":
      return "Secret response sent";
    case "image.attach_bytes":
      return "Image attached";
    default:
      return method ? `Called ${humanizeMethod(method)}` : "Action sent";
  }
}

function titleForPendingAction(rawType: string | undefined): string {
  switch (rawType) {
    case "approval.request":
      return "Approval requested";
    case "clarify.request":
      return "Clarification requested";
    case "sudo.request":
      return "Privilege approval requested";
    case "secret.request":
      return "Secret requested";
    default:
      return "User input requested";
  }
}

function titleForBackgroundEvent(rawType: string | undefined): string {
  const subtype = rawType?.startsWith("subagent.")
    ? rawType.slice("subagent.".length)
    : "";
  switch (subtype) {
    case "start":
      return "Background subagent started";
    case "tool":
      return "Background subagent used a tool";
    case "complete":
      return "Background subagent completed";
    case "error":
      return "Background subagent failed";
    case "blocked":
      return "Background subagent blocked";
    default:
      return "Background work updated";
  }
}

function titleForLifecycle(rawType: string | undefined): string {
  switch (rawType) {
    case "session.start":
      return "Session started";
    case "session.complete":
    case "session.completed":
      return "Session completed";
    case "gateway.ready":
      return "Gateway connected";
    default:
      return "Session status updated";
  }
}

function toolTitle(label: string, phase: string | undefined): string {
  const phrase = lowerFirst(stripTrailingPeriod(label));
  switch (phase) {
    case "start":
    case "running":
      return `Started ${phrase}`;
    case "progress":
      return `Updated ${phrase}`;
    case "complete":
      return `Completed ${phrase}`;
    case "failed":
      return `Failed ${phrase}`;
    default:
      return stripTrailingPeriod(label);
  }
}

function toolPhase(
  rawType: string | undefined,
  payload?: unknown,
): string | undefined {
  if (rawType === "tool.start") return "start";
  if (rawType === "tool.progress") return "progress";
  if (rawType === "tool.complete") {
    return payloadHasFailureSignal(payload) ? "failed" : "complete";
  }
  return undefined;
}

function artifactActionTitle(action: AgentArtifact["action"]): string {
  switch (action) {
    case "created":
      return "Created";
    case "modified":
      return "Modified";
    case "read":
      return "Read";
    case "downloaded":
      return "Downloaded";
    case "failed":
      return "Failed";
    case "attached":
      return "Attached";
  }
}

function detailFromPayload(
  payload: unknown,
  fallback?: string,
): string | undefined {
  const records = payloadRecords(payload);
  const value = firstString(records, [
    "description",
    "question",
    "command",
    "cmd",
    "path",
    "file_path",
    "filename",
    "url",
    "query",
    "q",
    "goal",
    "summary",
    "tool_preview",
    "text",
    "output",
    "message",
    "status",
  ]);
  return compactDetail(value ?? fallback);
}

function parsePayloadPreview(preview: string | undefined): unknown {
  if (!preview) return undefined;
  try {
    return JSON.parse(preview);
  } catch {
    return preview;
  }
}

function payloadRecords(payload: unknown): Record<string, unknown>[] {
  const root = objectRecord(payload);
  if (!root) return [];
  const records = [root];
  for (const key of ["arguments", "args", "input", "parameters", "payload"]) {
    const child = objectRecord(root[key]);
    if (child) records.push(child);
  }
  return records;
}

function payloadHasFailureSignal(payload: unknown): boolean {
  for (const record of payloadRecords(payload)) {
    if (
      record.error !== undefined &&
      record.error !== null &&
      record.error !== false
    ) {
      return true;
    }
    if (record.failed === true) return true;
    const status =
      typeof record.status === "string" ? record.status.toLowerCase() : "";
    if (status === "error" || status === "failed" || status === "denied") {
      return true;
    }
  }
  return false;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function firstString(
  records: Record<string, unknown>[],
  keys: string[],
): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return undefined;
}

function compactDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function isComputerUse(
  name: unknown,
  payload?: unknown,
  entry?: HermesTraceEntry,
): boolean {
  const haystack = [
    typeof name === "string" ? name : "",
    typeof payload === "string" ? payload : "",
    entry?.rawType ?? "",
    entry?.payloadKeys.join(" ") ?? "",
    entry?.payloadPreview ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return /\b(computer|screenshot|screen|display|mouse|cursor|click|keyboard|keypress|typed?|scroll|drag)\b/.test(
    haystack,
  );
}

function humanizeMethod(method: string): string {
  return method.replace(/[._-]+/g, " ");
}

function stripTrailingPeriod(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function lowerFirst(value: string): string {
  return value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
}

function compareRows(a: AgentEvidenceLogRow, b: AgentEvidenceLogRow): number {
  return timestampValue(a.timestamp) - timestampValue(b.timestamp);
}

function evidenceRowDedupeKey(row: AgentEvidenceLogRow): string {
  return [row.kind, row.title, row.detail ?? ""]
    .map((value) => value.replace(/\s+/g, " ").trim().toLowerCase())
    .join("\u0000");
}

function timestampValue(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatEvidenceTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function iconForKind(kind: AgentEvidenceLogRow["kind"]): JSX.Element {
  switch (kind) {
    case "computer":
      return <IconConsole size={14} />;
    case "tool":
      return <IconBolt size={14} />;
    case "file":
      return <IconFileText size={14} />;
    case "pending":
      return <IconHand5Finger size={14} />;
    case "background":
      return <IconRobot size={14} />;
    case "error":
      return <IconExclamationCircle size={14} />;
    case "action":
      return <IconEyeOpen size={14} />;
  }
}
