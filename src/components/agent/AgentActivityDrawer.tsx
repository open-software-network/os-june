import { IconAddImage } from "central-icons/IconAddImage";
import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconBolt } from "central-icons/IconBolt";
import { IconBubbleWide } from "central-icons/IconBubbleWide";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconClock } from "central-icons/IconClock";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconExclamationTriangle } from "central-icons/IconExclamationTriangle";
import { IconEyeOpen } from "central-icons/IconEyeOpen";
import { IconFileArrowRightOut } from "central-icons/IconFileArrowRightOut";
import { IconFileText } from "central-icons/IconFileText";
import { IconFolderOpen } from "central-icons/IconFolderOpen";
import { IconGlobe } from "central-icons/IconGlobe";
import { IconHand5Finger } from "central-icons/IconHand5Finger";
import { IconLayersTwo } from "central-icons/IconLayersTwo";
import { IconPencilLine } from "central-icons/IconPencilLine";
import { IconPlay } from "central-icons/IconPlay";
import { IconRobot } from "central-icons/IconRobot";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconShieldCrossed } from "central-icons/IconShieldCrossed";
import { IconStop } from "central-icons/IconStop";
import { IconStopCircle } from "central-icons/IconStopCircle";
import { useCallback, useState } from "react";
import type {
  BackgroundHermesActivity,
  BackgroundHermesPhase,
  HermesMode,
} from "../../lib/hermes-control-plane";
import { nonEmpty } from "../../lib/hermes-control-plane";
import type {
  AgentActivityPhase,
  AgentActivityRecord,
} from "../../lib/hermes-activity-store";
import type {
  AgentArtifact,
  ArtifactAction,
  ArtifactKind,
} from "../../lib/hermes-artifact-store";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { fileTypeIconComponent } from "./FileTypeIcon";

/**
 * Feature 13: who to interrupt. The trustworthy Hermes id (`handle` preferred,
 * else `subagentId`) for the subagent whose stop the user requested, plus its
 * owning session. The host's handler routes this to
 * `interruptSubagent({ sessionId, subagentId })`.
 */
export type SubagentStopTarget = { sessionId: string; subagentId: string };

/**
 * The Agent activity drawer (feature 11) — June's observability hub for "what
 * are my agents doing right now?". A product-facing panel (NOT a raw-frame
 * viewer; that's feature 15's trace panel) that lists one row per active session
 * with its phase, the tool in flight, pending-action and subagent counts, the
 * last-event age, the session mode (sandboxed / unrestricted), and, when the
 * host can resolve it, the model/provider. Each row offers open / steer / stop
 * actions routed back to the host.
 *
 * Pure presentational, mirroring {@link SessionUsagePanel} and
 * {@link PendingActionTray}: it takes the already-aggregated records (from
 * `hermesActivityStore`), resolver callbacks for title and model, and action
 * callbacks the host wires to its session-open / steer / stop mechanisms. `now`
 * is injected so age rendering is deterministic in tests.
 *
 * States: closed (renders nothing), loading (before the first snapshot), empty
 * (open, no activity), and active — where each row's phase is one of running /
 * waiting / background / error / complete. Feature 12 deepens the background
 * phase into a per-subagent "Background work" sub-list under the parent row
 * (each subagent's task, status, current tool, age, and completion summary).
 * The artifact timeline (feature 14) adds its own separate section; see the
 * store's extension notes.
 */
export function AgentActivityDrawer({
  open,
  records,
  status,
  now,
  titleForSession,
  modelForSession,
  onOpenSession,
  onSteerSession,
  canSteerSession,
  onStopSession,
  onStopSubagent,
  onClose,
  footer,
}: {
  /** Whether the drawer is visible. Closed → renders nothing. */
  open: boolean;
  /** Aggregated session rows, newest-first (already sorted by the store). */
  records: AgentActivityRecord[];
  /** `loading` until the first store snapshot is in; then `ready`. */
  status: "loading" | "ready";
  /** Current epoch ms, for age display. */
  now: number;
  /** Resolve a session id to a display title; `undefined` → row falls back to the id. */
  titleForSession: (sessionId: string) => string | undefined;
  /** Optional model/provider resolver (e.g. from feature 09's usage). */
  modelForSession?: (
    sessionId: string,
  ) => { model?: string; provider?: string } | undefined;
  /** Open the owning session in the workspace. */
  onOpenSession: (sessionId: string) => void;
  /** Steer the live session (opens it and focuses the composer's steer input). */
  onSteerSession: (sessionId: string) => void;
  /**
   * Whether a session is actually steerable RIGHT NOW (a turn is running and
   * the gateway will accept `session.steer`). The host aligns this with the
   * composer's steer-input gate (`workingSessionIds`) so the drawer never
   * offers Steer for a waiting/blocked session, where it would be a dead end
   * (the steer input doesn't render). Omit to fall back to "any active phase".
   */
  canSteerSession?: (sessionId: string) => boolean;
  /** Interrupt/stop the live session. */
  onStopSession: (sessionId: string) => void;
  /**
   * Feature 13: interrupt ONE background subagent. The drawer only invokes this
   * for an ACTIVE subagent that carries a trustworthy Hermes id/handle (it never
   * invents an id), after confirming when the subagent is doing file/tool work.
   * Resolves on the gateway ack; a rejection means the subagent likely already
   * finished, which the drawer treats quietly (the eventual terminal event in
   * `records` reconciles the row) rather than as a noisy failure. Omit to render
   * subagent rows read-only.
   */
  onStopSubagent?: (target: SubagentStopTarget) => void | Promise<unknown>;
  /** Dismiss the drawer. */
  onClose: () => void;
  /**
   * Extra content rendered below the session list — feature 14 passes its
   * {@link AgentArtifactsSection} here so the artifacts timeline lives in the
   * drawer without this component owning the artifact store. Kept a generic
   * slot so it stays decoupled from any one section.
   */
  footer?: JSX.Element | null;
}) {
  // Feature 13: optimistic "stopping" overlay + destructive-confirm flow for
  // per-subagent interrupts. Lives here (not per row) so the overlay survives
  // re-renders/reordering and a single dialog mounts for the whole drawer.
  const stop = useSubagentStop(onStopSubagent);

  // Hooks must run unconditionally, so the closed early-return comes after them.
  if (!open) return null;

  const hasActivity = records.length > 0;
  const activeCount = records.filter((record) =>
    isActivePhase(record.phase),
  ).length;

  return (
    <section className="agent-activity-drawer" aria-label="Agent activity">
      <header className="agent-activity-drawer-header">
        <span className="agent-activity-drawer-heading">
          <IconBolt size={15} ariaHidden />
          <span className="agent-activity-drawer-title">Agent activity</span>
          {activeCount > 0 ? (
            <span className="agent-activity-drawer-count" aria-hidden>
              {activeCount}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          className="agent-activity-drawer-close"
          onClick={onClose}
          aria-label="Close agent activity"
        >
          <IconCrossMedium size={15} ariaHidden />
        </button>
      </header>

      {status === "loading" ? (
        <p className="agent-activity-drawer-state">Loading activity…</p>
      ) : !hasActivity ? (
        <p className="agent-activity-drawer-state">
          No agents are working right now. Activity shows up here when a session
          starts running.
        </p>
      ) : (
        <ul className="agent-activity-drawer-list">
          {records.map((record) => (
            <ActivityRow
              key={record.id}
              record={record}
              title={titleForSession(record.sessionId)}
              model={modelForSession?.(record.sessionId)}
              now={now}
              onOpen={() => onOpenSession(record.sessionId)}
              onSteer={() => onSteerSession(record.sessionId)}
              canSteer={
                canSteerSession
                  ? canSteerSession(record.sessionId)
                  : isActivePhase(record.phase)
              }
              onStop={() => onStopSession(record.sessionId)}
              subagentStop={stop}
            />
          ))}
        </ul>
      )}

      {/* Feature 14's artifacts timeline (or anything else the host slots in).
          Rendered below the session list, outside the loading/empty branch so
          a session's files stay visible even when no agent is actively
          working. */}
      {footer}

      {/* Feature 13: one confirmation for a destructive subagent stop (the
          subagent is mid file/tool work). Non-destructive stops skip this and
          fire immediately; see useSubagentStop. */}
      <ConfirmDialog
        open={stop.confirm !== null}
        onClose={stop.cancelConfirm}
        onConfirm={stop.confirmStop}
        destructive
        title="Stop this background subagent?"
        description={
          stop.confirm
            ? `${stop.confirm.label} is using a tool right now. Stopping it may leave its work unfinished.`
            : undefined
        }
        confirmLabel="Stop subagent"
        cancelLabel="Keep running"
      />
    </section>
  );
}

/**
 * Feature 13 — the per-subagent stop controller, shared by every subagent row.
 *
 * Optimistic state: a `Set` of the trustworthy ids (handle or subagentId) the
 * user has asked to stop. A row in this set reads "Stopping" and drops its stop
 * button immediately, before the gateway round-trip. The set is the local
 * overlay the spec calls for — `BackgroundHermesActivity.phase` stays owned by
 * the classifier; we never mutate it. The overlay is reconciled away naturally:
 * once a row's phase goes terminal (a later `complete`/`error` event reaches the
 * drawer via `records`), the row no longer consults the overlay, so a stale id
 * lingering in the set is inert and harmless.
 *
 * Confirmation: destructive stops (the subagent is mid file/tool work) park a
 * pending request and surface a {@link ConfirmDialog}; everything else fires at
 * once. Either path optimistically marks the id stopping, then calls the host's
 * `interruptSubagent`. A rejection (the subagent already finished) is swallowed:
 * the row settles to complete from the event stream rather than showing an
 * error.
 */
type SubagentStopController = {
  /** Whether a given trustworthy id is in the optimistic "stopping" overlay. */
  isStopping: (id: string) => boolean;
  /** Whether per-subagent interrupt is wired at all (hides the button if not). */
  enabled: boolean;
  /** Begin a stop. `destructive` routes through the confirmation dialog. */
  request: (request: {
    sessionId: string;
    interruptId: string;
    label: string;
    destructive: boolean;
  }) => void;
  /** The pending destructive confirmation, or null. */
  confirm: { label: string } | null;
  /** Resolve the confirmation (fires the interrupt). */
  confirmStop: () => void;
  /** Dismiss the confirmation without stopping. */
  cancelConfirm: () => void;
};

function useSubagentStop(
  onStopSubagent:
    | ((target: SubagentStopTarget) => void | Promise<unknown>)
    | undefined,
): SubagentStopController {
  const [stoppingIds, setStoppingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pending, setPending] = useState<{
    sessionId: string;
    interruptId: string;
    label: string;
  } | null>(null);

  const run = useCallback(
    (sessionId: string, interruptId: string) => {
      // Optimistically mark it stopping (keyed by the trustworthy interrupt id).
      setStoppingIds((current) => {
        const next = new Set(current);
        next.add(interruptId);
        return next;
      });
      // Fire the interrupt. A rejection means the subagent had already
      // finished: stay quiet and let the event stream settle the row — drop the
      // optimistic overlay so it reconciles to its real (terminal) phase rather
      // than reading "stopping" forever.
      void Promise.resolve(
        onStopSubagent?.({ sessionId, subagentId: interruptId }),
      ).catch(() => {
        setStoppingIds((current) => {
          if (!current.has(interruptId)) return current;
          const next = new Set(current);
          next.delete(interruptId);
          return next;
        });
      });
    },
    [onStopSubagent],
  );

  const request = useCallback<SubagentStopController["request"]>(
    ({ sessionId, interruptId, label, destructive }) => {
      if (!onStopSubagent) return;
      if (destructive) {
        setPending({ sessionId, interruptId, label });
        return;
      }
      run(sessionId, interruptId);
    },
    [onStopSubagent, run],
  );

  const confirmStop = useCallback(() => {
    if (!pending) return;
    run(pending.sessionId, pending.interruptId);
    setPending(null);
  }, [pending, run]);

  const cancelConfirm = useCallback(() => setPending(null), []);

  return {
    isStopping: (id) => stoppingIds.has(id),
    enabled: Boolean(onStopSubagent),
    request,
    confirm: pending ? { label: pending.label } : null,
    confirmStop,
    cancelConfirm,
  };
}

function ActivityRow({
  record,
  title,
  model,
  now,
  onOpen,
  onSteer,
  canSteer,
  onStop,
  subagentStop,
}: {
  record: AgentActivityRecord;
  title: string | undefined;
  model: { model?: string; provider?: string } | undefined;
  now: number;
  onOpen: () => void;
  onSteer: () => void;
  canSteer: boolean;
  onStop: () => void;
  subagentStop: SubagentStopController;
}) {
  const sessionLabel = nonEmpty(title) ?? record.sessionId;
  const phase = phaseMeta(record.phase);
  // Stop is offered for any working phase; Steer only when the session is
  // actually steerable right now (a running turn), matching the composer's
  // steer-input gate so it's never a dead end.
  const live = isActivePhase(record.phase);
  const modelLabel = formatModel(model);

  return (
    <li className="agent-activity-row" data-phase={record.phase}>
      <span
        className="agent-activity-row-icon"
        data-phase={record.phase}
        aria-hidden
      >
        {phase.icon}
      </span>
      <div className="agent-activity-row-body">
        <div className="agent-activity-row-line">
          <span className="agent-activity-row-title">{sessionLabel}</span>
          <ModePill mode={record.mode} />
        </div>
        <div className="agent-activity-row-meta">
          <span className="agent-activity-row-phase" data-phase={record.phase}>
            {phase.label}
          </span>
          {record.phase === "running" && nonEmpty(record.currentTool) ? (
            <span className="agent-activity-row-tool">
              {record.currentTool}
            </span>
          ) : null}
          {record.pendingActionCount > 0 ? (
            <span
              className="agent-activity-row-pending"
              title={
                record.pendingActionCount === 1
                  ? "1 action needs you"
                  : `${record.pendingActionCount} actions need you`
              }
            >
              <IconHand5Finger size={12} ariaHidden />
              {record.pendingActionCount}
            </span>
          ) : null}
          {record.subagentCount > 0 ? (
            <span
              className="agent-activity-row-subagents"
              title={
                record.subagentCount === 1
                  ? "1 background subagent"
                  : `${record.subagentCount} background subagents`
              }
            >
              <IconRobot size={12} ariaHidden />
              {record.subagentCount}
            </span>
          ) : null}
          <span className="agent-activity-row-age">
            <IconClock size={12} ariaHidden />
            {formatAge(record.lastEventAt, now)}
          </span>
        </div>
        {modelLabel ? (
          <p className="agent-activity-row-model">{modelLabel}</p>
        ) : null}
      </div>
      <div className="agent-activity-row-actions">
        {canSteer ? (
          <button
            type="button"
            className="agent-activity-row-action"
            onClick={onSteer}
            aria-label={`Steer ${sessionLabel}`}
            title="Send a redirecting instruction"
          >
            <IconBubbleWide size={14} ariaHidden />
          </button>
        ) : null}
        {live ? (
          <button
            type="button"
            className="agent-activity-row-action agent-activity-row-action-stop"
            onClick={onStop}
            aria-label={`Stop ${sessionLabel}`}
            title="Stop this session"
          >
            <IconStop size={14} ariaHidden />
          </button>
        ) : null}
        <button
          type="button"
          className="agent-activity-row-action"
          onClick={onOpen}
          aria-label={`Open session ${sessionLabel}`}
          title="Open this session"
        >
          <IconArrowUpRight size={14} ariaHidden />
        </button>
      </div>

      {/* ─── Feature 12: background subagent watch ───────────────────────────
       * The parent session's delegated subagents, one row each, rendered as a
       * "Background work" sub-list spanning the full row width below the parent.
       * This region is OWNED BY FEATURE 12 and is intentionally kept separate
       * from feature 14's artifact timeline (which adds its own distinct
       * section) — do not fold artifact rendering in here. */}
      {record.subagents.length > 0 ? (
        <SubagentList
          sessionId={record.sessionId}
          subagents={record.subagents}
          now={now}
          subagentStop={subagentStop}
        />
      ) : null}
    </li>
  );
}

/**
 * Feature 12 — the "Background work" sub-list under a parent session row. One
 * {@link SubagentRow} per delegated subagent, ordered first-seen (as the store
 * upserts them). Distinct from feature 14's artifact section.
 */
function SubagentList({
  sessionId,
  subagents,
  now,
  subagentStop,
}: {
  sessionId: string;
  subagents: BackgroundHermesActivity[];
  now: number;
  subagentStop: SubagentStopController;
}) {
  return (
    <ul className="agent-activity-subagents" aria-label="Background work">
      {subagents.map((subagent) => (
        <SubagentRow
          key={subagent.subagentId}
          sessionId={sessionId}
          subagent={subagent}
          now={now}
          subagentStop={subagentStop}
        />
      ))}
    </ul>
  );
}

/**
 * Feature 12 — one delegated subagent. Shows its task/goal, status, the tool in
 * flight (when working), the last-event age, and the completion summary once it
 * finishes.
 *
 * SEAM for feature 13 (subagent interrupt): the stable Hermes ids ride on the
 * row as `data-subagent-id` (always present — the classifier guarantees a
 * non-empty id) and `data-subagent-handle` (when Hermes also sent a handle).
 * Feature 13 reads these to target an interrupt at a trustworthy id and slots a
 * stop button into `agent-activity-subagent-actions` without restructuring the
 * row.
 */
function SubagentRow({
  sessionId,
  subagent,
  now,
  subagentStop,
}: {
  sessionId: string;
  subagent: BackgroundHermesActivity;
  now: number;
  subagentStop: SubagentStopController;
}) {
  const task = nonEmpty(subagent.goal) ?? subagent.subagentId;
  const lastEventAt = Date.parse(subagent.lastEventAt);
  const working = subagent.phase === "tool" || subagent.phase === "progress";
  const preview = nonEmpty(subagent.resultPreview);

  // Feature 13: the trustworthy id we'd interrupt — the handle if Hermes sent
  // one, else the subagentId. NOT the classifier's "subagent" sentinel (used
  // when a payload carried no id at all): we never invent a target. Active
  // subagents (non-terminal phase) with such an id get a stop button.
  const interruptId = trustworthyInterruptId(subagent);
  const terminal = isTerminalSubagentPhase(subagent.phase);
  // The optimistic overlay only applies while the subagent is still live. The
  // moment a terminal event (complete/error) reconciles the row, the real phase
  // WINS — a lingering id in the overlay set is ignored — so the row settles to
  // its true outcome rather than reading "stopping" forever.
  const stopping =
    !terminal &&
    interruptId !== undefined &&
    subagentStop.isStopping(interruptId);
  const canStop =
    subagentStop.enabled && interruptId !== undefined && !terminal && !stopping;

  // While the optimistic overlay is on, the row reads "Stopping" instead of its
  // last reported phase — until a terminal event reconciles it (see
  // useSubagentStop). The phase attributes stay the classifier's truth.
  const status = stopping ? "Stopping" : subagentPhaseMeta(subagent.phase);

  return (
    <li
      className="agent-activity-subagent"
      data-phase={subagent.phase}
      data-subagent-id={subagent.subagentId}
      data-subagent-handle={nonEmpty(subagent.handle) ?? undefined}
      data-stopping={stopping ? "true" : undefined}
    >
      <span
        className="agent-activity-subagent-icon"
        data-phase={subagent.phase}
        aria-hidden
      >
        <IconRobot size={13} />
      </span>
      <div className="agent-activity-subagent-body">
        <div className="agent-activity-subagent-line">
          <span className="agent-activity-subagent-task">{task}</span>
        </div>
        <div className="agent-activity-subagent-meta">
          <span
            className="agent-activity-subagent-status"
            data-phase={subagent.phase}
            data-stopping={stopping ? "true" : undefined}
          >
            {status}
          </span>
          {working && nonEmpty(subagent.currentTool) ? (
            <span className="agent-activity-subagent-tool">
              {subagent.currentTool}
            </span>
          ) : null}
          {Number.isFinite(lastEventAt) ? (
            <span className="agent-activity-subagent-age">
              <IconClock size={11} ariaHidden />
              {formatAge(lastEventAt, now)}
            </span>
          ) : null}
        </div>
        {preview ? (
          <p className="agent-activity-subagent-summary">{preview}</p>
        ) : null}
      </div>
      {/* Feature 13: the per-subagent stop button, targeting the trustworthy id.
          Only for an active subagent with such an id and a wired handler;
          otherwise the row stays read-only (feature 12's empty actions slot). */}
      <div className="agent-activity-subagent-actions">
        {canStop && interruptId !== undefined ? (
          <button
            type="button"
            className="agent-activity-subagent-stop"
            onClick={() =>
              subagentStop.request({
                sessionId,
                interruptId,
                label: task,
                // A subagent mid file/tool work gets a confirmation; otherwise
                // the stop fires immediately.
                destructive: subagent.phase === "tool",
              })
            }
            aria-label={`Stop subagent ${task}`}
            title="Stop this background subagent"
          >
            <IconStopCircle size={14} ariaHidden />
          </button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Feature 13 — the id we'd actually interrupt, or `undefined` if there is none
 * we trust. Prefers the Hermes `handle`, falls back to `subagentId`, but
 * REJECTS the classifier's `"subagent"` sentinel (its stand-in for a payload
 * with no id/handle at all): interrupting a made-up id could hit the wrong
 * subagent, so such a row stays read-only.
 */
function trustworthyInterruptId(
  subagent: BackgroundHermesActivity,
): string | undefined {
  const handle = nonEmpty(subagent.handle);
  if (handle && handle !== "subagent") return handle;
  const id = nonEmpty(subagent.subagentId);
  if (id && id !== "subagent") return id;
  return undefined;
}

/** Terminal subagent phases — no live work to interrupt, so no stop button. */
function isTerminalSubagentPhase(phase: BackgroundHermesPhase): boolean {
  return phase === "complete" || phase === "error";
}

/** Per-subagent status label. Sentence case (project copy rule); no dashes. */
function subagentPhaseMeta(phase: BackgroundHermesPhase): string {
  switch (phase) {
    case "start":
      return "Starting";
    case "progress":
      return "Working";
    case "tool":
      return "Using a tool";
    case "thinking":
      return "Thinking";
    case "complete":
      return "Complete";
    case "error":
      return "Error";
    case "blocked":
      return "Blocked";
  }
}

function ModePill({ mode }: { mode: HermesMode }) {
  const unrestricted = mode === "unrestricted";
  return (
    <span
      className="agent-activity-row-mode"
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

/** Per-phase label + icon. Labels are sentence case (project copy rule). */
function phaseMeta(phase: AgentActivityPhase): {
  label: string;
  icon: JSX.Element;
} {
  switch (phase) {
    case "running":
      return { label: "Running", icon: <IconPlay size={15} ariaHidden /> };
    case "waiting":
      return {
        label: "Waiting for you",
        icon: <IconHand5Finger size={15} ariaHidden />,
      };
    case "background":
      return {
        label: "Background work",
        icon: <IconLayersTwo size={15} ariaHidden />,
      };
    case "error":
      return {
        label: "Error",
        icon: <IconExclamationCircle size={15} ariaHidden />,
      };
    case "complete":
      return {
        label: "Complete",
        icon: <IconCircleCheck size={15} ariaHidden />,
      };
  }
}

/** Phases where the session is still working — only these get stop/steer. */
function isActivePhase(phase: AgentActivityPhase): boolean {
  return phase === "running" || phase === "waiting" || phase === "background";
}

/** "model · provider", "model", or undefined. Middle dot, not a dash. */
function formatModel(
  model: { model?: string; provider?: string } | undefined,
): string | undefined {
  const name = nonEmpty(model?.model);
  const provider = nonEmpty(model?.provider);
  if (name && provider) return `${name} · ${provider}`;
  return name ?? provider;
}

/**
 * Compact "x ago" age. Plain hyphens/words only (project copy rule: no en/em
 * dashes). Sub-minute reads "just now" so a fresh row doesn't show "0m".
 */
function formatAge(lastEventAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - lastEventAt) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// ===========================================================================
// Feature 14 — Artifacts (files touched) timeline
// ---------------------------------------------------------------------------
// A SELF-CONTAINED region of the drawer, distinct from the per-session rows
// above and from feature 12's subagent/background-activity sub-list (which
// deepens the `background` phase rows). It renders the files an agent created /
// modified / read / downloaded, plus failed file accesses, sourced from
// `hermesArtifactStore` (NOT the activity record). A click routes back to the
// host's EXISTING file preview/download flow (AgentWorkspace's
// `AgentArtifactPanel`, via `hermes_bridge_file_preview` / `_file_text` /
// `download_hermes_bridge_file`) — this component never fetches files itself.
//
// Exported standalone so AgentWorkspace can host it where it makes sense (the
// drawer footer today) and so it is unit-testable in isolation. Touching the
// subagent region is feature 12's job; do not wire background-activity here.
// ===========================================================================

/**
 * The "Artifacts" section: a flat, newest-first list of {@link AgentArtifact}
 * rows for one session. Renders nothing when the session has touched no files,
 * so the drawer stays quiet until there is something to show. The session mode
 * is rendered per row as a path-safety label (a sandboxed copy vs an
 * unrestricted local path vs a remote/backend path) so the blast radius of each
 * file is legible at a glance.
 */
export function AgentArtifactsSection({
  artifacts,
  onOpenArtifact,
}: {
  /** This session's artifacts, newest-first (already sorted by the store). */
  artifacts: AgentArtifact[];
  /** Open the artifact in the host's existing preview/download flow. */
  onOpenArtifact: (artifact: AgentArtifact) => void;
}) {
  if (artifacts.length === 0) return null;

  return (
    <section className="agent-artifacts-section" aria-label="Artifacts">
      <header className="agent-artifacts-header">
        <span className="agent-artifacts-heading">
          <IconFileText size={14} ariaHidden />
          <span className="agent-artifacts-title">Artifacts</span>
          <span className="agent-artifacts-count" aria-hidden>
            {artifacts.length}
          </span>
        </span>
      </header>
      <ul className="agent-artifacts-list">
        {artifacts.map((artifact) => (
          <ArtifactRow
            key={artifact.id}
            artifact={artifact}
            onOpen={() => onOpenArtifact(artifact)}
          />
        ))}
      </ul>
    </section>
  );
}

function ArtifactRow({
  artifact,
  onOpen,
}: {
  artifact: AgentArtifact;
  onOpen: () => void;
}) {
  const name =
    nonEmpty(artifact.displayName) ?? nonEmpty(artifact.path) ?? "File";
  const action = actionMeta(artifact.action);
  const safety = pathSafetyMeta(artifact);

  return (
    <li
      className="agent-artifacts-row"
      data-action={artifact.action}
      data-kind={artifact.kind}
    >
      <button
        type="button"
        className="agent-artifacts-button"
        onClick={onOpen}
        title={artifact.path ?? name}
      >
        <span
          className="agent-artifacts-icon"
          data-action={artifact.action}
          aria-hidden
        >
          {kindIcon(artifact.kind, name)}
        </span>
        <span className="agent-artifacts-body">
          <span className="agent-artifacts-name">{name}</span>
          <span className="agent-artifacts-meta">
            <span
              className="agent-artifacts-action"
              data-action={artifact.action}
            >
              {action.icon}
              {action.label}
            </span>
            <span
              className="agent-artifacts-safety"
              data-safety={safety.key}
              title={safety.title}
            >
              {safety.icon}
              {safety.label}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

/** Per-action label + small leading icon. Labels are sentence case (copy rule). */
function actionMeta(action: ArtifactAction): {
  label: string;
  icon: JSX.Element;
} {
  switch (action) {
    case "created":
      return {
        label: "Created",
        icon: <IconFileArrowRightOut size={12} ariaHidden />,
      };
    case "modified":
      return {
        label: "Modified",
        icon: <IconPencilLine size={12} ariaHidden />,
      };
    case "read":
      return { label: "Read", icon: <IconEyeOpen size={12} ariaHidden /> };
    case "downloaded":
      return {
        label: "Downloaded",
        icon: <IconArrowInbox size={12} ariaHidden />,
      };
    case "failed":
      return {
        label: "Failed",
        icon: <IconExclamationTriangle size={12} ariaHidden />,
      };
    case "attached":
      return {
        label: "Attached",
        icon: <IconAddImage size={12} ariaHidden />,
      };
  }
}

/** The glyph for the artifact kind. Files reuse the extension-keyed
 * {@link fileTypeIconComponent} so a .png/.pdf/.csv reads as itself. */
function kindIcon(kind: ArtifactKind, name: string): JSX.Element {
  if (kind === "directory") return <IconFolderOpen size={15} ariaHidden />;
  if (kind === "url") return <IconGlobe size={15} ariaHidden />;
  const Icon = fileTypeIconComponent(name);
  return <Icon size={15} />;
}

/**
 * The path-safety label, derived from the artifact's mode + kind. This is the
 * "show mode + path safety clearly" requirement: a sandboxed file is a copy in
 * June's sandbox, an unrestricted file is a real path on the user's machine, and
 * a url is remote. The text is sentence case; no en/em dashes.
 */
function pathSafetyMeta(artifact: AgentArtifact): {
  key: "sandboxed" | "unrestricted" | "remote";
  label: string;
  title: string;
  icon: JSX.Element;
} {
  if (artifact.kind === "url") {
    return {
      key: "remote",
      label: "Remote",
      title: "A remote location, not a file on this machine",
      icon: <IconGlobe size={12} ariaHidden />,
    };
  }
  if (artifact.mode === "unrestricted") {
    return {
      key: "unrestricted",
      label: "Unrestricted path",
      title: "A real path on your machine (this session is not sandboxed)",
      icon: <IconShieldCrossed size={12} ariaHidden />,
    };
  }
  return {
    key: "sandboxed",
    label: "Sandboxed copy",
    title: "A copy inside June's sandbox, not your wider filesystem",
    icon: <IconShieldCheck size={12} ariaHidden />,
  };
}
