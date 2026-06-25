import { IconAiTokens } from "central-icons/IconAiTokens";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconCoins } from "central-icons/IconCoins";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconGauge } from "central-icons/IconGauge";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionUsage } from "../../lib/hermes-session-usage";

/**
 * Self-contained session usage / context / cost panel (feature 09). Renders the
 * metrics the gateway reports for one session: active model/provider, token
 * counts, context window fill, and an ESTIMATED cost (always labeled as an
 * estimate, never as exact), plus any per-tool/subagent cost breakdown.
 *
 * Decoupled from the gateway on purpose: it takes a `fetchUsage(sessionId)`
 * function that already normalizes the raw `session.usage` result into a
 * {@link SessionUsage} (see `parseSessionUsage`). That keeps the panel trivially
 * testable and lets feature 11's activity drawer reuse it as a tab by passing
 * the same fetcher. Missing fields degrade to "Unavailable" rather than break.
 */
export function SessionUsagePanel({
  sessionId,
  fetchUsage,
  onClose,
}: {
  sessionId: string;
  fetchUsage: (sessionId: string) => Promise<SessionUsage>;
  onClose: () => void;
}) {
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  // The reason the fetch rejected, surfaced so the failure is honest about
  // whether the session ended, the gateway is down, or usage is unsupported —
  // each of which the user can act on differently.
  const [errorReason, setErrorReason] = useState<string | null>(null);
  // Guards against a resolve landing after unmount or after a newer refresh.
  const requestSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++requestSeq.current;
    setStatus("loading");
    fetchUsage(sessionId).then(
      (next) => {
        if (seq !== requestSeq.current) return;
        setUsage(next);
        setStatus("ready");
      },
      (err: unknown) => {
        if (seq !== requestSeq.current) return;
        setErrorReason(err instanceof Error ? err.message : String(err));
        setStatus("error");
      },
    );
  }, [fetchUsage, sessionId]);

  // Fetch once on mount (and whenever the target session changes). Refresh is
  // an explicit user action — we do not poll.
  useEffect(() => {
    load();
    return () => {
      // Invalidate any in-flight request so it cannot setState post-unmount.
      requestSeq.current++;
    };
  }, [load]);

  return (
    <section className="agent-usage-panel" aria-label="Session usage">
      <header className="agent-usage-header">
        <span className="agent-usage-title">
          <IconGauge size={15} ariaHidden />
          Usage
        </span>
        <div className="agent-usage-header-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh usage"
            title="Refresh"
            disabled={status === "loading"}
            onClick={load}
          >
            <IconArrowRotateClockwise size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close usage"
            title="Close"
            onClick={onClose}
          >
            <IconCrossSmall size={14} />
          </button>
        </div>
      </header>

      {status === "error" ? (
        <div className="agent-usage-error" role="status">
          <p>Couldn't load usage for this session.</p>
          {errorReason ? (
            <p className="agent-usage-error-detail">{errorReason}</p>
          ) : null}
          <button type="button" className="agent-usage-retry" onClick={load}>
            Try again
          </button>
        </div>
      ) : (
        <div className="agent-usage-body" aria-busy={status === "loading"}>
          <dl className="agent-usage-grid">
            <Metric label="Model" value={usage?.model} />
            <Metric label="Provider" value={usage?.provider} />
            <Metric
              label="Prompt tokens"
              value={formatCount(usage?.promptTokens)}
            />
            <Metric
              label="Completion tokens"
              value={formatCount(usage?.completionTokens)}
            />
            <Metric
              label="Total tokens"
              value={formatCount(usage?.totalTokens)}
            />
          </dl>

          <ContextMeter used={usage?.contextUsed} limit={usage?.contextLimit} />

          <CostSection
            estimatedCostUsd={usage?.estimatedCostUsd}
            toolCosts={usage?.toolCosts}
          />
        </div>
      )}
    </section>
  );
}

/** A label/value row. Empty/absent values render the sentence-case
 * "Unavailable" placeholder rather than a blank or a guessed zero. */
function Metric({ label, value }: { label: string; value?: string }) {
  const present = value !== undefined && value !== "";
  return (
    <div className="agent-usage-metric">
      <dt>{label}</dt>
      <dd data-unavailable={present ? undefined : "true"}>
        {present ? value : "Unavailable"}
      </dd>
    </div>
  );
}

/** Context window fill. Shows a proportional bar only when both used and limit
 * are known; otherwise the row still renders with an "Unavailable" reading so
 * the user sees the metric exists. */
function ContextMeter({ used, limit }: { used?: number; limit?: number }) {
  const hasBoth = used !== undefined && limit !== undefined && limit > 0;
  const pct = hasBoth ? Math.min(100, Math.max(0, (used / limit) * 100)) : null;
  const reading = hasBoth
    ? `${formatCount(used)} / ${formatCount(limit)}`
    : "Unavailable";

  return (
    <div className="agent-usage-context">
      <div className="agent-usage-context-head">
        <span className="agent-usage-context-label">Context used</span>
        <span
          className="agent-usage-context-reading"
          data-unavailable={hasBoth ? undefined : "true"}
        >
          {reading}
          {pct !== null ? ` (${Math.round(pct)}%)` : ""}
        </span>
      </div>
      {pct !== null ? (
        <div
          className="agent-usage-bar"
          role="progressbar"
          aria-label="Context used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <div className="agent-usage-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** Cost block. The dollar figure is ALWAYS framed as an estimate, never exact,
 * and the per-tool breakdown (if any) is listed beneath it. */
function CostSection({
  estimatedCostUsd,
  toolCosts,
}: {
  estimatedCostUsd?: number;
  toolCosts?: SessionUsage["toolCosts"];
}) {
  const hasTotal = estimatedCostUsd !== undefined;
  return (
    <div className="agent-usage-cost">
      <div className="agent-usage-cost-head">
        <span className="agent-usage-cost-label">
          <IconCoins size={14} ariaHidden />
          Estimated cost
        </span>
        <span
          className="agent-usage-cost-value"
          data-unavailable={hasTotal ? undefined : "true"}
        >
          {hasTotal ? formatUsd(estimatedCostUsd) : "Unavailable"}
        </span>
      </div>
      <p className="agent-usage-cost-note">
        Estimate only, based on reported token usage. Actual billing may differ.
      </p>
      {toolCosts && toolCosts.length > 0 ? (
        <ul
          className="agent-usage-tool-costs"
          aria-label="Tool and subagent costs"
        >
          {toolCosts.map((cost) => (
            <li key={cost.name}>
              <span className="agent-usage-tool-name">
                <IconAiTokens size={13} ariaHidden />
                {cost.name}
              </span>
              <span
                className="agent-usage-tool-value"
                data-unavailable={
                  cost.estimatedCostUsd === undefined ? "true" : undefined
                }
              >
                {cost.estimatedCostUsd !== undefined
                  ? formatUsd(cost.estimatedCostUsd)
                  : "Unavailable"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Group-format a token count, or undefined when absent (so the caller can
 * fall back to "Unavailable"). */
function formatCount(value?: number): string | undefined {
  return value === undefined ? undefined : value.toLocaleString();
}

/** Format a USD amount with enough precision for small per-call costs. Sub-cent
 * values keep four decimals so they don't collapse to "$0.00". */
function formatUsd(value: number): string {
  const decimals = value > 0 && value < 0.01 ? 4 : 2;
  return `$${value.toFixed(decimals)}`;
}
