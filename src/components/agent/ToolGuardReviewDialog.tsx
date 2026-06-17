import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { useEffect, useMemo, useState } from "react";
import type {
  ToolGuardDecisionAction,
  ToolGuardDecisionFinding,
  ToolGuardDecisionRequest,
  ToolGuardDecisionResponse,
} from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";

const TOOL_GUARD_DECISION_EVENT = "tool-guard-decision-request";

export function ToolGuardReviewDialog() {
  const [queue, setQueue] = useState<ToolGuardDecisionRequest[]>([]);
  const [selectedFindingIds, setSelectedFindingIds] = useState<Set<string>>(
    new Set(),
  );
  const [submitting, setSubmitting] = useState<ToolGuardDecisionAction | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const active = queue[0] ?? null;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ToolGuardDecisionRequest>(
      TOOL_GUARD_DECISION_EVENT,
      (event) => {
        if (!event.payload) return;
        setQueue((items) => [...items, event.payload]);
      },
    ).then((cleanup) => {
      if (disposed) {
        cleanup();
        return;
      }
      unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    setSubmitting(null);
    setError(null);
    setSelectedFindingIds(
      new Set(active?.findings.map((finding) => finding.findingId) ?? []),
    );
  }, [active?.decisionId]);

  const selectedCount = selectedFindingIds.size;
  const findingCount = active?.findings.length ?? 0;
  const toolLabel = active?.toolName || active?.destinationId || "this tool";
  const description = active
    ? active.kind === "toolCall"
      ? `Tool Guard found sensitive data before June calls ${toolLabel}.`
      : `Tool Guard found sensitive data before June returns data from ${toolLabel} to the model.`
    : "";

  async function answer(action: ToolGuardDecisionAction) {
    if (!active || submitting) return;
    setSubmitting(action);
    setError(null);
    try {
      await invoke<void>("hermes_bridge_tool_guard_decision", {
        response: {
          decisionId: active.decisionId,
          action,
          selectedFindingIds:
            action === "redactSelected" ? Array.from(selectedFindingIds) : [],
        } satisfies ToolGuardDecisionResponse,
      });
      setQueue((items) => items.slice(1));
    } catch (err) {
      setError(messageFromError(err));
      setSubmitting(null);
    }
  }

  const footer = active ? (
    <>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={Boolean(submitting)}
        onClick={() => void answer("cancel")}
      >
        Cancel
      </button>
      <button
        type="button"
        className="btn btn-ghost tool-guard-raw"
        disabled={Boolean(submitting)}
        onClick={() => void answer("allowRaw")}
      >
        Continue raw
      </button>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={Boolean(submitting) || findingCount === 0}
        onClick={() => void answer("redactAll")}
      >
        Redact all
      </button>
      <button
        type="button"
        className="primary-action primary-solid"
        disabled={
          Boolean(submitting) || findingCount === 0 || selectedCount === 0
        }
        onClick={() => void answer("redactSelected")}
      >
        Redact selected
      </button>
    </>
  ) : null;

  return (
    <Dialog
      open={Boolean(active)}
      onClose={() => void answer("cancel")}
      title="Review tool data"
      description={description}
      leading={<IconShieldCheck size={18} aria-hidden />}
      footer={footer}
      disableBackdropClose
      width={560}
      className="tool-guard-dialog"
    >
      {active ? (
        <div className="tool-guard-review">
          <ToolGuardFindings
            findings={active.findings}
            selected={selectedFindingIds}
            onToggle={(findingId, checked) => {
              setSelectedFindingIds((current) => {
                const next = new Set(current);
                if (checked) next.add(findingId);
                else next.delete(findingId);
                return next;
              });
            }}
          />
          {active.advisories.length > 0 ? (
            <div className="tool-guard-advisories">
              <p>Advisories</p>
              <ul>
                {active.advisories.map((advisory) => (
                  <li key={advisory.advisoryId}>
                    {humanize(advisory.advisoryType)} (
                    {advisory.confidenceBucket})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {error ? <p className="tool-guard-error">{error}</p> : null}
        </div>
      ) : null}
    </Dialog>
  );
}

function ToolGuardFindings({
  findings,
  selected,
  onToggle,
}: {
  findings: ToolGuardDecisionFinding[];
  selected: Set<string>;
  onToggle: (findingId: string, checked: boolean) => void;
}) {
  const rows = useMemo(
    () =>
      findings.map((finding) => ({
        finding,
        label: humanize(finding.piiType),
        preview: previewText(finding.originalText),
      })),
    [findings],
  );

  if (rows.length === 0) {
    return (
      <p className="tool-guard-empty">
        Tool Guard reported advisories without a redaction plan.
      </p>
    );
  }

  return (
    <div className="tool-guard-findings">
      {rows.map(({ finding, label, preview }) => (
        <label key={finding.findingId} className="tool-guard-finding">
          <input
            type="checkbox"
            checked={selected.has(finding.findingId)}
            onChange={(event) =>
              onToggle(finding.findingId, event.currentTarget.checked)
            }
          />
          <span>
            <span className="tool-guard-finding-title">
              {label} ({finding.confidenceBucket})
            </span>
            <code>{preview}</code>
          </span>
        </label>
      ))}
    </div>
  );
}

function previewText(value?: string | null) {
  const text = value?.trim();
  if (!text) return "Sensitive value";
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}

function humanize(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function messageFromError(err: unknown) {
  if (err && typeof err === "object") {
    const maybe = err as { message?: unknown };
    if (typeof maybe.message === "string" && maybe.message.trim()) {
      return maybe.message;
    }
  }
  return "Could not send the Tool Guard decision.";
}
