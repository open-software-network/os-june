import { IconBell } from "central-icons/IconBell";
import { IconCircleQuestionmark } from "central-icons/IconCircleQuestionmark";
import { IconConsole } from "central-icons/IconConsole";
import { IconKey1 } from "central-icons/IconKey1";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconShieldCrossed } from "central-icons/IconShieldCrossed";
import { useState } from "react";
import type {
  HermesMode,
  PendingHermesAction,
} from "../../lib/hermes-control-plane";
import { nonEmpty } from "../../lib/hermes-control-plane";
import type { PendingActionRecord } from "../../lib/hermes-pending-actions";

/**
 * The global "Needs you" tray (feature 04). A top-level surface that aggregates
 * every outstanding pending action across ALL sessions — the cross-session view
 * the inline cards (feature 03) can't give — so the user can see, at a glance,
 * everything Hermes is blocked on and jump straight to the right session.
 *
 * Pure presentational: it takes the already-resolved open records, a
 * `titleForSession` resolver (so it never reaches into session state itself),
 * and an `onOpenAction` callback the host wires to its session-open mechanism.
 * `now` is injected so age rendering is deterministic in tests and cheap to
 * re-derive on the host's render cadence.
 *
 * Safety: a secret row shows only which key is requested (`keyName`) and never a
 * value — the record's action is `redacted: true` by construction; this
 * component additionally never reads or renders any value field.
 */
export function PendingActionTray({
  records,
  titleForSession,
  onOpenAction,
  now,
}: {
  /** Open/stale actions to show, newest-first (already filtered by the store). */
  records: PendingActionRecord[];
  /** Resolve a session id to a display title; `undefined` → row falls back to the id. */
  titleForSession: (sessionId: string) => string | undefined;
  /** Open the session and focus the inline card for this request. */
  onOpenAction: (target: { sessionId: string; requestId: string }) => void;
  /** Current epoch ms, for age display. */
  now: number;
}) {
  const [collapsed, setCollapsed] = useState(false);

  // Nothing pending → render nothing (no empty chrome competing for attention).
  if (records.length === 0) return null;

  const count = records.length;

  return (
    <section
      className="agent-pending-tray"
      aria-label="Needs you"
      data-collapsed={collapsed ? "true" : undefined}
    >
      <header className="agent-pending-tray-header">
        <button
          type="button"
          className="agent-pending-tray-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <IconBell size={15} ariaHidden />
          <span className="agent-pending-tray-title">Needs you</span>
          <span className="agent-pending-tray-count" aria-hidden>
            {count}
          </span>
          <span className="agent-pending-tray-count-sr">
            {count === 1 ? "1 action needs you" : `${count} actions need you`}
          </span>
        </button>
      </header>

      {collapsed ? null : (
        <ul className="agent-pending-tray-list">
          {records.map((record) => (
            <PendingActionRow
              key={record.key}
              record={record}
              title={titleForSession(record.sessionId)}
              now={now}
              onOpen={() =>
                onOpenAction({
                  sessionId: record.sessionId,
                  requestId: record.requestId,
                })
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PendingActionRow({
  record,
  title,
  now,
  onOpen,
}: {
  record: PendingActionRecord;
  title: string | undefined;
  now: number;
  onOpen: () => void;
}) {
  const meta = actionMeta(record.action);
  const sessionLabel = nonEmpty(title) ?? record.sessionId;
  const isStale = record.status === "stale";

  return (
    <li
      className="agent-pending-row"
      data-kind={record.action.kind}
      data-stale={isStale ? "true" : undefined}
    >
      <span className="agent-pending-row-icon" aria-hidden>
        {meta.icon}
      </span>
      <div className="agent-pending-row-body">
        <div className="agent-pending-row-line">
          <span className="agent-pending-row-type">{meta.label}</span>
          <ModePill mode={record.mode} />
          {isStale ? (
            <span
              className="agent-pending-row-stale"
              title="Not reconfirmed since reconnecting"
            >
              Unconfirmed
            </span>
          ) : null}
        </div>
        <div className="agent-pending-row-session">
          <span className="agent-pending-row-title">{sessionLabel}</span>
          <span className="agent-pending-row-age">
            {formatAge(record.firstSeenAt, now)}
          </span>
        </div>
        {meta.description ? (
          <p className="agent-pending-row-desc">{meta.description}</p>
        ) : null}
      </div>
      <button
        type="button"
        className="agent-pending-row-action"
        onClick={onOpen}
        aria-label={`Respond in ${sessionLabel}`}
      >
        Respond
      </button>
    </li>
  );
}

function ModePill({ mode }: { mode: HermesMode }) {
  const unrestricted = mode === "unrestricted";
  return (
    <span
      className="agent-pending-row-mode"
      data-mode={mode}
      title={
        unrestricted
          ? "This session can change files outside the sandbox"
          : "This session is sandboxed"
      }
    >
      {unrestricted ? (
        <IconShieldCrossed size={12} ariaHidden />
      ) : (
        <IconShieldCheck size={12} ariaHidden />
      )}
      {unrestricted ? "Unrestricted" : "Sandboxed"}
    </span>
  );
}

/**
 * Per-kind presentation: a label, an icon, and a concise description. The
 * description is drawn only from non-secret fields; a secret's value is never
 * available here (the action is `redacted`), so the row shows which key is
 * wanted and why, never a value.
 */
function actionMeta(action: PendingHermesAction): {
  label: string;
  icon: JSX.Element;
  description?: string;
} {
  switch (action.kind) {
    case "clarify":
      return {
        label: "Needs clarification",
        icon: <IconCircleQuestionmark size={16} ariaHidden />,
        description: nonEmpty(action.question),
      };
    case "approval":
      return {
        label: "Approval needed",
        icon: <IconShieldCheck size={16} ariaHidden />,
        description: nonEmpty(action.description) ?? nonEmpty(action.toolName),
      };
    case "sudo":
      return {
        label: "Command approval",
        icon: <IconConsole size={16} ariaHidden />,
        description: nonEmpty(action.command) ?? nonEmpty(action.reason),
      };
    case "secret":
      return {
        label: "Secret requested",
        icon: <IconKey1 size={16} ariaHidden />,
        // Only metadata: which key, and why. Never a value.
        description: secretDescription(action.keyName, action.reason),
      };
  }
}

function secretDescription(
  keyName: string | undefined,
  reason: string | undefined,
): string | undefined {
  const key = nonEmpty(keyName);
  const why = nonEmpty(reason);
  if (key && why) return `${key} (${why})`;
  if (key) return key;
  if (why) return why;
  return undefined;
}

/**
 * Compact "x ago" age. Plain hyphens/words only (project copy rule: no en/em
 * dashes). Sub-minute reads "just now" so a fresh row doesn't show "0m".
 */
function formatAge(firstSeenAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - firstSeenAt) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
