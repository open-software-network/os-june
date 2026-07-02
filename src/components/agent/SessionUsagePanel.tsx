import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import type { HTMLAttributes } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SessionUsage } from "../../lib/hermes-session-usage";
import { modelPrivacyBadge } from "../../lib/model-privacy";
import type { VeniceModelDto } from "../../lib/tauri";
import { ModelPrivacyChip } from "../ui/ModelPrivacyChip";

/**
 * Self-contained session usage / context / cost panel (feature 09). Renders the
 * metrics the gateway reports for one session as a compact card:
 *
 * 1. a model row up top (display name + muted "Model" + privacy chip),
 * 2. a segmented dotted context meter (only when both used and limit are known),
 * 3. a quiet "Show more" toggle that reveals the detail disclosure, holding the
 *    input/output/total token rows, any per-tool/subagent cost rows, and the
 *    ESTIMATED cost (always framed as an estimate, never as exact) with its fine
 *    print, as plain rows. Collapsed by default; the toggle only appears when the
 *    disclosure would carry at least one row.
 *
 * Missing fields drop their row rather than showing a placeholder; a payload
 * with nothing usable shows a single empty-state line. The very first load
 * renders the REAL structure with placeholder content — a shimmer bar where the
 * model name lands, the real 60-segment meter track sitting empty (unlit), and
 * two shimmer bars where the legend reading and percent land — so nothing jumps
 * when data arrives: the text placeholders cross-fade to real copy in place and
 * the live track starts from a pixel-identical empty state before lighting up
 * with its eased sweep.
 *
 * Decoupled from the gateway on purpose: it takes a `fetchUsage(sessionId)`
 * function that already normalizes the raw `session.usage` result into a
 * {@link SessionUsage} (see `parseSessionUsage`). That keeps the panel trivially
 * testable and lets feature 11's activity drawer reuse it as a tab by passing
 * the same fetcher. `resolveModel` maps a raw model id to its full DTO, so the
 * panel can show both the display name and the privacy badge.
 */
export function SessionUsagePanel({
  sessionId,
  fetchUsage,
  onClose,
  resolveModel,
}: {
  sessionId: string;
  fetchUsage: (sessionId: string) => Promise<SessionUsage>;
  onClose: () => void;
  resolveModel?: (modelId: string) => VeniceModelDto | undefined;
}) {
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  // The reason the fetch rejected, surfaced so the failure is honest about
  // whether the session ended, the gateway is down, or usage is unsupported —
  // each of which the user can act on differently.
  const [errorReason, setErrorReason] = useState<string | null>(null);
  // Increments once per user-initiated refresh so the refresh icon spins a full
  // turn (the initial mount fetch does not spin). Mirrors AccountSettings.
  const [spins, setSpins] = useState(0);
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

  // A user-initiated refresh spins the icon a full turn; the mount fetch does not.
  const handleRefresh = useCallback(() => {
    setSpins((turns) => turns + 1);
    load();
  }, [load]);

  // First load has no data yet; a refresh keeps the prior card visible (dimmed).
  const firstLoad = status === "loading" && usage === null;

  return (
    <section className="agent-usage-panel" aria-label="Session usage">
      {/* A real (non-absolute) header row: the "Usage" title anchors the panel on
          the left, the refresh/close actions sit on the right. Borderless by
          design — no divider — so it flows into the body. */}
      <div className="agent-usage-header">
        <h2 className="agent-usage-title">Usage</h2>
        <div className="agent-usage-header-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh usage"
            title="Refresh"
            disabled={status === "loading"}
            onClick={handleRefresh}
          >
            <IconArrowRotateClockwise
              size={14}
              className="balance-refresh-icon"
              style={{ transform: `rotate(${spins * 360}deg)` }}
            />
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
      </div>

      {status === "error" ? (
        <div className="agent-usage-error" role="status">
          <p>Couldn't load usage for this session.</p>
          {errorReason ? <p className="agent-usage-error-detail">{errorReason}</p> : null}
          <button type="button" className="agent-usage-retry" onClick={load}>
            Try again
          </button>
        </div>
      ) : firstLoad ? (
        // First load: render the real structure with placeholder content. The
        // layout is known before data arrives, so we mount the same body
        // container with a shimmer bar for the model name, the real (empty) meter
        // track, and two shimmer bars for the legend — nothing jumps when the
        // payload lands and the placeholders swap to real content in place.
        <div className="agent-usage-body" aria-busy="true">
          <UsageSkeleton />
        </div>
      ) : (
        // Same body container as the skeleton, so the transition keeps the
        // vertical rhythm stable: the text elements cross-fade to real copy while
        // the live meter starts from the same empty track before lighting up. A
        // refresh dims via aria-busy without remounting, so nothing replays.
        <div className="agent-usage-body" aria-busy={status === "loading"}>
          <UsageContent usage={usage} resolveModel={resolveModel} />
        </div>
      )}
    </section>
  );
}

/** The card body once a payload has loaded. Drops straight to the empty state
 * when the payload carries nothing usable so the card never shows bare rows. */
function UsageContent({
  usage,
  resolveModel,
}: {
  usage: SessionUsage | null;
  resolveModel?: (modelId: string) => VeniceModelDto | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const disclosureId = useId();

  if (!usage || isEmptyUsage(usage)) {
    return <p className="agent-usage-empty">No usage reported for this session yet.</p>;
  }

  const modelDto = usage.model !== undefined ? resolveModel?.(usage.model) : undefined;
  const modelName = usage.model !== undefined ? (modelDto?.name ?? usage.model) : undefined;
  // Privacy chip when we resolved the DTO; otherwise fall back to the raw
  // provider string on the right as before (nothing when neither is known).
  const privacyBadge = modelDto ? modelPrivacyBadge(modelDto) : undefined;

  // Clamp the meter limit to the model's real context window. The runtime's
  // reported context_max can be a runtime default (observed: 1,000,000) larger
  // than the active model's actual window (e.g. a 200K model), so when the
  // catalog knows a positive contextTokens we take the smaller of the two as the
  // honest denominator; either alone stands when only one exists.
  const effectiveLimit =
    modelDto?.contextTokens !== undefined &&
    modelDto.contextTokens > 0 &&
    usage.contextLimit !== undefined
      ? Math.min(modelDto.contextTokens, usage.contextLimit)
      : modelDto?.contextTokens !== undefined && modelDto.contextTokens > 0
        ? modelDto.contextTokens
        : usage.contextLimit;

  // The disclosure carries the token rows, per-tool costs, and estimated cost.
  // The toggle only renders when at least one of those rows would show.
  const hasToolCosts = (usage.toolCosts?.length ?? 0) > 0;
  const hasDetails =
    usage.promptTokens !== undefined ||
    usage.completionTokens !== undefined ||
    usage.totalTokens !== undefined ||
    usage.estimatedCostUsd !== undefined ||
    hasToolCosts;

  return (
    <>
      {modelName !== undefined ? (
        <div className="agent-usage-row agent-usage-model-row">
          <span className="agent-usage-primary">
            {modelName}
            <span className="agent-usage-secondary">Model</span>
          </span>
          {/* Privacy chip sits inline after the model name (chat-surface style)
              as the brand-tinted themed pill, shrunk to the small height so it
              reads as a dense in-row badge. Falls back to the raw provider
              string, muted, in the same left cluster. */}
          {privacyBadge ? (
            <ModelPrivacyChip badge={privacyBadge} variant="themed" size="sm" />
          ) : usage.provider !== undefined ? (
            <span className="agent-usage-muted">{usage.provider}</span>
          ) : null}
        </div>
      ) : null}

      <ContextMeter used={usage.contextUsed} limit={effectiveLimit} />

      {hasDetails ? (
        <div className="agent-usage-details">
          <button
            type="button"
            className="agent-usage-more"
            aria-expanded={expanded}
            aria-controls={disclosureId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show more"}
            <IconChevronDownSmall size={12} className="agent-disclosure-chevron" aria-hidden />
          </button>

          <div className="agent-usage-disclosure" data-open={expanded || undefined}>
            {/* The clipped inner wrapper drives the grid-rows reveal; the detail
                rows sit inside it (no backdrop) with a padding-top so the reveal
                keeps its internal spacing as it animates open. */}
            <div
              className="agent-usage-disclosure-inner"
              id={disclosureId}
              aria-hidden={!expanded}
            >
              <div className="agent-usage-rows agent-usage-detail-rows">
                <TokenRow label="Input" value={usage.promptTokens} />
                <TokenRow label="Output" value={usage.completionTokens} />

                {usage.totalTokens !== undefined ? (
                  <div className="agent-usage-row">
                    <span className="agent-usage-primary">Total</span>
                    <span className="agent-usage-value">{formatCount(usage.totalTokens)}</span>
                  </div>
                ) : null}

                {usage.toolCosts?.map((cost) => (
                  <div className="agent-usage-row" key={cost.name}>
                    <span className="agent-usage-muted agent-usage-tool-name">{cost.name}</span>
                    {cost.estimatedCostUsd !== undefined ? (
                      <span className="agent-usage-value">{formatUsd(cost.estimatedCostUsd)}</span>
                    ) : null}
                  </div>
                ))}

                {usage.estimatedCostUsd !== undefined ? (
                  <>
                    <div className="agent-usage-row">
                      <span className="agent-usage-primary">Estimated cost</span>
                      <span className="agent-usage-cost-value">
                        {formatUsd(usage.estimatedCostUsd)}
                      </span>
                    </div>
                    <p className="agent-usage-fine-print">
                      Estimate based on reported token usage. Actual billing may differ.
                    </p>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** A muted-label / value breakdown row for a token count. Renders nothing when
 * the count is absent. */
function TokenRow({ label, value }: { label: string; value?: number }) {
  if (value === undefined) return null;
  return (
    <div className="agent-usage-row">
      <span className="agent-usage-muted">{label}</span>
      <span className="agent-usage-value">{formatCount(value)}</span>
    </div>
  );
}

/** Fixed number of segments in the context meter. A constant count rendered with
 * `space-between` means whole ticks always, gaps distribute at any width, and
 * clipping is impossible (no mask, no fractional last tick). Thin tall ticks fit
 * more of them than round dots did. */
const METER_SEGMENTS = 60;

/** Total span the light-up wavefront takes to cross the lit dots on load. The
 * per-dot delay is the inverse of an ease-out cubic, so the front moves fast at
 * first and decelerates into the last lit dot — an eased wavefront, not a linear
 * `index * ms` march — like a gauge needle coming to rest. The sweep is
 * color-only: every tick rests at the same size, so lit ticks sit within the
 * exact bounds of the gray ticks beneath; the staggered delays flip the lit
 * segments' background left to right. */
const SWEEP_MS = 550;

/** Segmented context meter (tall thin ticks). Renders only when both used and
 * limit are known; when context is unknown the whole section is omitted. The
 * ticks light up left to right on mount in the primary color, deepening to the
 * themed warm-strong tone once usage crosses the near-full threshold (>= 90%).
 * Deliberately not --destructive: a nearly-full context is a heads up June can
 * compact away, not an error, and red overclaims. There is no separate mid
 * "warn" tier either - one intensity shift is the whole signal. */
function ContextMeter({ used, limit }: { used?: number; limit?: number }) {
  const hasBoth = used !== undefined && limit !== undefined && limit > 0;
  // Mount unlit, then light up one frame later so the per-dot color transition
  // (or its reduced-motion no-op) plays as a left-to-right sweep.
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    if (!hasBoth) return;
    const frame = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(frame);
  }, [hasBoth]);

  if (!hasBoth) return null;

  const pct = Math.min(100, Math.max(0, (used / limit) * 100));
  const rounded = Math.round(pct);
  const level = pct >= 90 ? "critical" : "normal";
  // Any nonzero usage lights at least one segment so a sliver of context still
  // reads as "in use"; zero usage lights none.
  const litCount = grown
    ? pct > 0
      ? Math.max(1, Math.round((pct / 100) * METER_SEGMENTS))
      : 0
    : 0;

  return (
    <div className="agent-usage-meter">
      <MeterTrack
        litCount={litCount}
        level={level}
        aria={{
          role: "progressbar",
          "aria-label": "Context used",
          "aria-valuemin": 0,
          "aria-valuemax": 100,
          "aria-valuenow": rounded,
        }}
      />
      <div className="agent-usage-meter-legend">
        <span className="agent-usage-meter-reading">
          {formatCount(used)}
          <span className="agent-usage-muted">
            {" / "}
            {formatCount(limit)} tokens
          </span>
        </span>
        <span className="agent-usage-meter-percent">{rounded}%</span>
      </div>
    </div>
  );
}

/** The 60-segment meter track markup, shared by the live {@link ContextMeter}
 * and the first-load {@link UsageSkeleton} so the segment-rendering loop lives
 * in exactly one place. Given `litCount` it flips that many leading segments to
 * their lit color with the eased left-to-right wavefront; the skeleton passes
 * `litCount={0}` to render the meter's empty (all-unlit) state. The skeleton
 * and live subtrees are different components, so the track node does remount on
 * the swap - the handoff stays seamless only because this shared markup makes
 * the live track's pre-sweep frame pixel-identical to the skeleton's empty
 * track. ARIA is opt-in: the live
 * meter passes the progressbar attributes, the skeleton passes none (it is
 * decorative). */
function MeterTrack({
  litCount,
  level,
  aria,
}: {
  litCount: number;
  level: "normal" | "critical";
  aria?: HTMLAttributes<HTMLDivElement> & { role?: string };
}) {
  return (
    <div className="agent-usage-meter-track" data-level={level} {...aria}>
      {Array.from({ length: METER_SEGMENTS }, (_, index) => {
        const lit = index < litCount;
        // Eased wavefront: delay = SWEEP_MS * (1 - cbrt(1 - f)) is the inverse
        // of an ease-out cubic across the lit segments, so the front is quick
        // early and settles softly into the last lit segment. Unlit segments
        // carry no delay.
        const f = litCount <= 1 ? 0 : index / (litCount - 1);
        const delay = lit ? SWEEP_MS * (1 - Math.cbrt(1 - f)) : 0;
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static list of positional segments.
            key={index}
            className="agent-usage-meter-segment"
            data-lit={lit || undefined}
            style={{ transitionDelay: `${delay}ms` }}
          />
        );
      })}
    </div>
  );
}

/** First-load placeholder: the real body structure with shimmer bars standing in
 * for the model name and the legend reading/percent, wrapped around the real
 * (empty) meter track. Because it shares the body container, vertical rhythm,
 * and {@link MeterTrack} markup with the loaded content, the swap to real data
 * is seamless: the text cross-fades and the live track starts from the same
 * empty frame before lighting up. */
function UsageSkeleton() {
  return (
    <>
      <div className="agent-usage-row agent-usage-model-row">
        <span className="agent-usage-skeleton agent-usage-skeleton-model" />
      </div>
      <div className="agent-usage-meter">
        <MeterTrack litCount={0} level="normal" />
        <div className="agent-usage-meter-legend">
          <span className="agent-usage-skeleton agent-usage-skeleton-reading" />
          <span className="agent-usage-skeleton agent-usage-skeleton-percent" />
        </div>
      </div>
    </>
  );
}

/** True when the payload carries no metric worth a row: nothing to show but the
 * empty-state line. */
function isEmptyUsage(usage: SessionUsage): boolean {
  return (
    usage.model === undefined &&
    usage.provider === undefined &&
    usage.promptTokens === undefined &&
    usage.completionTokens === undefined &&
    usage.totalTokens === undefined &&
    usage.contextUsed === undefined &&
    usage.contextLimit === undefined &&
    usage.estimatedCostUsd === undefined &&
    (usage.toolCosts === undefined || usage.toolCosts.length === 0)
  );
}

/** Group-format a token count. */
function formatCount(value: number): string {
  return value.toLocaleString();
}

/** Format a USD amount with enough precision for small per-call costs. Sub-cent
 * values keep four decimals so they don't collapse to "$0.00". */
function formatUsd(value: number): string {
  const decimals = value > 0 && value < 0.01 ? 4 : 2;
  return `$${value.toFixed(decimals)}`;
}
