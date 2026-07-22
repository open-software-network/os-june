import { IconArrowCornerDownRight } from "central-icons/IconArrowCornerDownRight";
import { IconCheckCircle2 } from "central-icons/IconCheckCircle2";
import { IconConcise } from "central-icons/IconConcise";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconExclamationTriangle } from "central-icons/IconExclamationTriangle";
import { useEffect, useRef, useState } from "react";
import {
  UPSTREAM_PROVIDER_FAILURE_NOTICE_BODY,
  type AgentChatPart,
} from "../../../lib/agent-chat-runtime";
import { isSessionBusyError } from "../../../lib/hermes-gateway";
import type { CompressSessionResult } from "../../../lib/hermes-session-compress";
import { TierMiniCard, type FundingTier } from "../../account/FundingNotice";
import { Dialog } from "../../ui/Dialog";
import { InlineNotice } from "../../ui/InlineNotice";

export function SessionCompactDialog({
  open,
  sessionId,
  compress,
  onClose,
}: {
  open: boolean;
  sessionId: string;
  compress: (sessionId: string) => Promise<CompressSessionResult>;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "working" | "done" | "error">("idle");
  const [result, setResult] = useState<CompressSessionResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Guards against a resolve landing after a newer run or after close/reopen.
  const requestSeq = useRef(0);

  // Reset to the confirmation each time the dialog (re)opens so a prior run's
  // result or error never leaks into a fresh session's confirmation.
  useEffect(() => {
    if (open) {
      requestSeq.current++;
      setPhase("idle");
      setResult(null);
      setErrorMessage(null);
    }
  }, [open]);

  function runCompaction() {
    const seq = ++requestSeq.current;
    setPhase("working");
    setErrorMessage(null);
    compress(sessionId).then(
      (next) => {
        if (seq !== requestSeq.current) return;
        setResult(next);
        setPhase("done");
      },
      (err) => {
        if (seq !== requestSeq.current) return;
        setErrorMessage(
          isSessionBusyError(err)
            ? "June is running right now. Wait for the current turn to finish, then compact context."
            : "Couldn't compact context. Please try again.",
        );
        setPhase("error");
      },
    );
  }

  const working = phase === "working";

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!working) onClose();
      }}
      title="Compact context"
      leading={<IconConcise size={16} aria-hidden />}
      width={440}
      disableBackdropClose={working}
      footer={
        phase === "done" ? (
          <button type="button" className="primary-action" onClick={onClose}>
            Done
          </button>
        ) : phase === "error" ? (
          <>
            <button type="button" className="primary-action" onClick={onClose}>
              Close
            </button>
            <button type="button" className="primary-action primary-solid" onClick={runCompaction}>
              Try again
            </button>
          </>
        ) : (
          <>
            <button type="button" className="primary-action" onClick={onClose} disabled={working}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              onClick={runCompaction}
              disabled={working}
            >
              {working ? "Compacting…" : "Compact context"}
            </button>
          </>
        )
      }
    >
      <div className="agent-compact-body">
        {phase === "done" ? (
          <CompactSuccess result={result} />
        ) : phase === "error" ? (
          <InlineNotice
            className="agent-compact-error"
            tone="destructive"
            role="alert"
            body={errorMessage ?? "Couldn't compact context. Please try again."}
          />
        ) : (
          <>
            <p className="agent-compact-explainer">
              This summarizes older context so the agent can continue with a smaller working memory.
            </p>
            <p className="agent-compact-caveat">
              Older messages may be summarized. The agent keeps a reference summary rather than the
              full earlier transcript.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Success body for {@link SessionCompactDialog}: a confirmation line, plus the
 * before/after token reading ONLY when the result reported both (never a
 * guessed or partial figure). */
function CompactSuccess({ result }: { result: CompressSessionResult | null }) {
  const before = result?.beforeTokens;
  const after = result?.afterTokens;
  const hasSavings = before !== undefined && after !== undefined;
  const saved = hasSavings ? Math.max(0, before - after) : undefined;

  return (
    <div className="agent-compact-success" role="status">
      <p className="agent-compact-success-line">
        <IconCheckCircle2 size={15} aria-hidden />
        Context compacted
      </p>
      {hasSavings ? (
        <p className="agent-compact-savings">
          {before.toLocaleString()} to {after.toLocaleString()} tokens
          {saved !== undefined && saved > 0 ? ` (${saved.toLocaleString()} saved)` : ""}
        </p>
      ) : (
        <p className="agent-compact-savings" data-unavailable="true">
          The agent now continues with a smaller working memory.
        </p>
      )}
    </div>
  );
}

// The shared .error-banner tint, with actions: dismiss always, and "Try again"
// when the failure is connection-shaped and reconnecting can actually fix it.
export function AgentErrorBanner({
  message,
  onDismiss,
  onReportBug,
  onRetry,
  reportBugSubmitting = false,
}: {
  message: string;
  onDismiss: () => void;
  onReportBug?: () => void;
  onRetry?: () => void;
  reportBugSubmitting?: boolean;
}) {
  return (
    <div className="error-banner agent-error-banner" role="alert">
      <p>{message}</p>
      <div className="agent-error-banner-actions">
        {onRetry ? (
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        ) : null}
        {onReportBug ? (
          <button type="button" onClick={onReportBug} disabled={reportBugSubmitting}>
            {reportBugSubmitting ? "Sending" : "Send bug report"}
          </button>
        ) : null}
        <button type="button" aria-label="Dismiss" onClick={onDismiss}>
          <IconCrossMedium size={14} />
        </button>
      </div>
    </div>
  );
}

export function CreditsNoticePart({
  onTopUp,
  topUpLabel = "Upgrade",
  tier,
}: {
  onTopUp?: () => void;
  topUpLabel?: string;
  tier?: FundingTier;
}) {
  return (
    <InlineNotice
      className="agent-credits-notice"
      tone="destructive"
      role="alert"
      icon={tier ? <TierMiniCard tier={tier} /> : <IconExclamationTriangle size={14} aria-hidden />}
      body="June stopped because your balance ran out."
      actions={
        onTopUp ? (
          <button type="button" className="btn btn-secondary" onClick={onTopUp}>
            {topUpLabel}
          </button>
        ) : undefined
      }
    />
  );
}

export function UpstreamProviderFailureNoticePart({
  attempted = false,
  disabled = false,
  onRetry,
}: {
  attempted?: boolean;
  disabled?: boolean;
  onRetry?: () => void;
}) {
  return (
    <InlineNotice
      className="agent-upstream-provider-notice"
      tone="warning"
      role="alert"
      icon={<IconExclamationTriangle size={14} aria-hidden />}
      body={UPSTREAM_PROVIDER_FAILURE_NOTICE_BODY}
      actions={
        onRetry ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={attempted || disabled}
            onClick={onRetry}
          >
            Try again
          </button>
        ) : undefined
      }
    />
  );
}

// A turn that died because the request outgrew the model's context (or the
// agent request-size limit) folds into this card instead of a raw "Cannot
// compress further." error with only Copy/Branch (JUN-169). On a single
// oversized turn there is nothing to compress, so the honest recovery is to
// shrink the input or start fresh, not to retry as-is. No wired action yet —
// the guidance points at the composer / branch controls already on the turn.
export function ContextOverflowNoticePart() {
  return (
    <InlineNotice
      className="agent-context-overflow-notice"
      tone="warning"
      role="alert"
      icon={<IconExclamationTriangle size={14} aria-hidden />}
      body="This message is too large for the model's context. Try attaching a smaller file, splitting it into parts, or starting a new session."
    />
  );
}

/** A "Steering" system item (feature 06): the instruction the user redirected
 * June toward mid-run, recorded quietly in the transcript so the conversation
 * shows what changed course. Mirrors {@link ContextCompactionPart}'s quiet,
 * timestamped system-row styling. */
export function SteeringPart({ part }: { part: Extract<AgentChatPart, { type: "steering" }> }) {
  return (
    <div className="agent-steering-item">
      <span className="agent-steering-icon" aria-hidden>
        <IconArrowCornerDownRight size={14} />
      </span>
      <span className="agent-steering-label">Steering</span>
      <span className="agent-steering-text">{part.text}</span>
    </div>
  );
}

// The `/image` result, inline in the assistant turn. Running -> generation state;
// complete -> the image (click to enlarge in the file viewer) with a download
// action; error -> the failure message. The bytes ride in `part.dataUrl` for an
// instant thumbnail; open/download key off the imported workspace path.
/* The June Agents mark sampled onto the generating dot lattice, one character
 * per 6px cell: "." = outside the glyph, digits 1-9 = the fraction of the
 * cell the glyph covers. Derived from src/assets/june-agents-mark.svg by
 * rasterizing with a slight blur (4px at 10px cells) and averaging per-cell
 * alpha - the blur spreads each edge across two cells, so dots taper in size
 * and tone toward the boundary and the glyph keeps its soft rounded edges
 * instead of a hard binary cutout. */
