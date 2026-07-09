import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconCalendarRepeat } from "central-icons/IconCalendarRepeat";
import { IconPlay } from "central-icons/IconPlay";
import { IconShieldCrossed } from "central-icons/IconShieldCrossed";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { IconPause } from "central-icons/IconPause";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  TRIGGER_META,
  eventTriggerScheduleDraft,
  routineToolsetsFor,
  triggerConfigFromDraft,
  type TriggerDraft,
} from "../../lib/connectors";
import {
  pauseRoutine,
  resumeRoutine,
  routineUnrestricted,
  type RoutineJob,
  type RoutineUpdates,
} from "../../lib/hermes-routines";
import {
  compactScheduleLabel,
  draftFromSchedule,
  scheduleFromDraft,
  type ScheduleDraft,
} from "../../lib/routine-schedule";
import {
  connectorTriggerDelete,
  connectorTriggerSet,
  connectorTriggersList,
  connectorsApplyRuntime,
  connectorsList,
  routineTrustGet,
  routineTrustSet,
  type ConnectorAccount,
  type ConnectorTrigger,
  type HermesSessionInfo,
  type RoutineTrust,
  type RoutineTrustMode,
} from "../../lib/tauri";
import {
  HERMES_SERVER_ERROR_MESSAGE,
  isHermesServerError,
  messageFromError,
} from "../../lib/errors";
import { BreadcrumbBar } from "../ui/BreadcrumbBar";
import { HoverTip } from "../ui/HoverTip";
import { Switch } from "../ui/Switch";
import { toast } from "../ui/Toaster";
import { userFacingFailureMessage } from "../note-editor/NoteFailureBanner";
import { GrowingTextarea } from "./GrowingTextarea";
import { RoutineModePicker } from "./RoutineModePicker";
import { formatRunTime, RoutineRunList } from "./RoutineRunList";
import { TriggerPicker } from "./TriggerPicker";
import { TrustModePicker } from "./TrustModePicker";

/** Maps a stored connector trigger back onto the editor's "When" model. Key
 * order matters: the dirty check compares drafts via JSON.stringify, so this
 * must build objects in the same shape TriggerPicker emits. */
function triggerDraftFromStored(stored: ConnectorTrigger): TriggerDraft {
  if (stored.kind === "email_received") return { source: "email_received" };
  const lead = stored.config.leadMinutes;
  const external = stored.config.externalOnly;
  return {
    source: "event_upcoming",
    leadMinutes: typeof lead === "number" ? lead : 30,
    externalOnly: typeof external === "boolean" ? external : true,
  };
}

type RoutineDetailProps = {
  routine: RoutineJob;
  /** Past runs of this routine only. */
  runs: HermesSessionInfo[];
  busy: boolean;
  saving: boolean;
  error: string | null;
  onBack: () => void;
  onSave: (updates: RoutineUpdates) => Promise<void>;
  onToggleActive: () => void;
  onRunNow: () => Promise<void>;
  onDelete: () => void;
  onOpenRun: (run: HermesSessionInfo) => void;
  onRetryLoad?: () => void;
  retrying?: boolean;
};

/** One routine, fully editable in place: schedule, instructions, access and
 * name save through the bridge's cron API, while activity (toggle, run now,
 * run history) acts immediately. Mount with `key={routine.job_id}` — the
 * draft fields initialize from the routine once and reconcile through the
 * dirty comparison after saves refresh the prop. */
export function RoutineDetail({
  routine,
  runs,
  busy,
  saving,
  error,
  onBack,
  onSave,
  onToggleActive,
  onRunNow,
  onDelete,
  onOpenRun,
  onRetryLoad,
  retrying,
}: RoutineDetailProps) {
  const [name, setName] = useState(routine.name);
  const [draft, setDraft] = useState<ScheduleDraft>(() => draftFromSchedule(routine.schedule));
  const [prompt, setPrompt] = useState(routine.prompt);
  const [unrestricted, setUnrestricted] = useState(() => routineUnrestricted(routine));
  // Connector trust + trigger. All loads degrade quietly: a routine without
  // a trust record (or a build without the connectors module) reads as
  // read only with no trigger, which is exactly the stored default.
  const [storedTrust, setStoredTrust] = useState<RoutineTrust | null>(null);
  const [trustMode, setTrustMode] = useState<RoutineTrustMode>("read_only");
  const [autonomousTools, setAutonomousTools] = useState<string[]>([]);
  const [storedTrigger, setStoredTrigger] = useState<ConnectorTrigger | null>(null);
  const [trigger, setTrigger] = useState<TriggerDraft>({ source: "schedule" });
  const [accounts, setAccounts] = useState<ConnectorAccount[]>([]);
  const [activeTab, setActiveTab] = useState<"details" | "history">("details");
  // "Run now" only queues the job for the scheduler's next tick, so the
  // confirmation is a short-lived label swap rather than a new run row.
  const [queued, setQueued] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tabIndicator, setTabIndicator] = useState({ x: 0, width: 0 });
  const queueTimer = useRef<number>();
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const detailsTabRef = useRef<HTMLButtonElement>(null);
  const historyTabRef = useRef<HTMLButtonElement>(null);
  const previousRoutineNameRef = useRef(routine.name);
  useEffect(() => () => window.clearTimeout(queueTimer.current), []);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointer(event: MouseEvent) {
      if (!menuWrapRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    let cancelled = false;
    routineTrustGet(routine.job_id)
      .then((trust) => {
        if (cancelled || !trust) return;
        setStoredTrust(trust);
        setTrustMode(trust.trustMode);
        setAutonomousTools(trust.autonomousTools);
      })
      .catch(() => {});
    connectorTriggersList(routine.job_id)
      .then((triggers) => {
        if (cancelled) return;
        const stored = triggers[0] ?? null;
        setStoredTrigger(stored);
        if (stored) setTrigger(triggerDraftFromStored(stored));
      })
      .catch(() => {});
    connectorsList()
      .then((list) => {
        if (!cancelled) setAccounts(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [routine.job_id]);

  useEffect(() => {
    const previousName = previousRoutineNameRef.current;
    previousRoutineNameRef.current = routine.name;
    setName((current) => {
      const trimmed = current.trim();
      if (!trimmed || trimmed === previousName) return routine.name;
      return current;
    });
  }, [routine]);

  useLayoutEffect(() => {
    function updateIndicator() {
      const tab = activeTab === "details" ? detailsTabRef.current : historyTabRef.current;
      if (!tab) return;
      setTabIndicator({ x: tab.offsetLeft, width: tab.offsetWidth });
    }
    updateIndicator();
    window.addEventListener("resize", updateIndicator);
    return () => window.removeEventListener("resize", updateIndicator);
  }, [activeTab]);

  const paused = routine.state === "paused";
  const completed = routine.state === "completed";

  const nameChanged = name.trim().length > 0 && name.trim() !== routine.name;
  const scheduleChanged =
    trigger.source === "schedule" &&
    JSON.stringify(draft) !== JSON.stringify(draftFromSchedule(routine.schedule));
  const promptChanged = prompt !== routine.prompt;
  const modeChanged = unrestricted !== routineUnrestricted(routine);
  const storedTrustMode = storedTrust?.trustMode ?? "read_only";
  const storedTools = storedTrust?.autonomousTools ?? [];
  const trustChanged =
    trustMode !== storedTrustMode ||
    (trustMode === "autonomous" && JSON.stringify(autonomousTools) !== JSON.stringify(storedTools));
  const storedTriggerDraft: TriggerDraft = storedTrigger
    ? triggerDraftFromStored(storedTrigger)
    : { source: "schedule" };
  const triggerChanged = JSON.stringify(trigger) !== JSON.stringify(storedTriggerDraft);
  const dirty =
    nameChanged ||
    scheduleChanged ||
    promptChanged ||
    modeChanged ||
    trustChanged ||
    triggerChanged;

  async function save() {
    const updates: RoutineUpdates = {};
    if (nameChanged) updates.name = name.trim();
    if (scheduleChanged) updates.schedule = scheduleFromDraft(draft);
    if (promptChanged) updates.prompt = prompt;

    // Whether this save added or removed a per-job autonomy server, which only
    // enters the rendered config when the runtime restarts.
    let autoServersChanged = false;

    // Trust first: an autonomous grant mints per-job auto server names that
    // the toolset override must reference.
    if (trustChanged) {
      try {
        const previousServers = storedTrust?.autonomousServers ?? [];
        const stored = await routineTrustSet({
          jobId: routine.job_id,
          trustMode,
          autonomousTools: trustMode === "autonomous" ? autonomousTools : undefined,
        });
        setStoredTrust(stored);
        updates.enabledToolsets = routineToolsetsFor(trustMode, {
          unrestricted,
          autonomousServers: stored.autonomousServers,
        });
        const nextServers = stored.autonomousServers ?? [];
        autoServersChanged =
          JSON.stringify([...previousServers].sort()) !== JSON.stringify([...nextServers].sort());
      } catch (err) {
        toast.error(messageFromError(err));
        return;
      }
    } else if (modeChanged) {
      // No trust change: connector routines recompose their toolsets around
      // the new base; plain routines keep the legacy boolean path.
      if (storedTrust) {
        updates.enabledToolsets = routineToolsetsFor(trustMode, {
          unrestricted,
          autonomousServers: storedTrust.autonomousServers,
        });
      } else {
        updates.unrestricted = unrestricted;
      }
    }

    if (triggerChanged) {
      try {
        if (trigger.source === "schedule") {
          if (storedTrigger) await connectorTriggerDelete(storedTrigger.id);
          setStoredTrigger(null);
          // Back on a real schedule: replace the far-future placeholder and
          // let the scheduler own the job again.
          updates.schedule = scheduleFromDraft(draft);
          await resumeRoutine(routine.job_id).catch(() => {});
        } else {
          const account = accounts.find((entry) => entry.status === "connected");
          if (!account) {
            toast.error("Connect a Google account before using an event trigger.");
            return;
          }
          const stored = await connectorTriggerSet({
            jobId: routine.job_id,
            kind: trigger.source,
            accountId: account.accountId,
            config: triggerConfigFromDraft(trigger),
          });
          setStoredTrigger(stored);
          if (storedTriggerDraft.source === "schedule") {
            // Newly event-driven: park the cron schedule far in the future
            // and pause; the trigger daemon fires the job from now on.
            updates.schedule = eventTriggerScheduleDraft().schedule;
            await pauseRoutine(routine.job_id).catch(() => {});
          }
        }
      } catch (err) {
        toast.error(messageFromError(err));
        return;
      }
    }

    await onSave(updates);

    // A new or removed per-job autonomy server only takes effect once the
    // runtime re-renders its config. Best-effort: it also registers on the
    // next runtime start.
    if (autoServersChanged) {
      await connectorsApplyRuntime().catch(() => {});
    }
  }

  async function runNow() {
    await onRunNow();
    setQueued(true);
    window.clearTimeout(queueTimer.current);
    queueTimer.current = window.setTimeout(() => setQueued(false), 5000);
  }

  const storedFailure =
    routine.last_status === "error"
      ? routine.last_error || routine.last_delivery_error || undefined
      : undefined;
  // A stored Hermes 5xx reads as raw wire text; classify it before the
  // generic failure wrapper (JUN-196).
  const failure = storedFailure
    ? isHermesServerError(storedFailure)
      ? HERMES_SERVER_ERROR_MESSAGE
      : userFacingFailureMessage(storedFailure)
    : null;

  return (
    <section className="routine-detail" aria-label={routine.name}>
      <BreadcrumbBar
        backLabel="Back to routines"
        onBack={onBack}
        items={[{ label: "Routines", onClick: onBack }, { label: name.trim() || routine.name }]}
        actions={
          <div className="routine-detail-actions">
            <div className="agent-session-menu-wrap" ref={menuWrapRef}>
              <button
                type="button"
                className="btn btn-ghost routine-detail-menu-trigger"
                aria-label="Routine actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <IconDotGrid1x3Horizontal size={16} />
              </button>
              {menuOpen ? (
                <div className="sidebar-identity-menu agent-session-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="destructive"
                    disabled={busy}
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete();
                    }}
                  >
                    <IconTrashCan size={14} />
                    Delete routine
                  </button>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || queued || routine.state !== "scheduled"}
              onClick={() => void runNow()}
            >
              <IconPlay size={13} aria-hidden />
              {queued ? "Queued" : "Run now"}
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={!dirty || !prompt.trim() || saving || busy}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        }
      />

      <div className="routine-detail-content">
        <div className="routine-detail-title-row">
          <input
            className="routine-detail-name"
            value={name}
            placeholder="Routine name"
            aria-label="Routine name"
            onChange={(event) => setName(event.currentTarget.value)}
          />
          {!completed ? (
            <label
              className="routine-detail-active-control"
              data-state={routine.state === "scheduled" ? "active" : "paused"}
            >
              <Switch
                checked={routine.state === "scheduled"}
                disabled={busy}
                aria-label={`${name.trim() || routine.name} active`}
                onCheckedChange={onToggleActive}
              />
            </label>
          ) : null}
        </div>

        <div className="routine-detail-meta">
          {routine.state === "scheduled" ? (
            <span className="routine-meta-pill routine-meta-pill-warm">Active</span>
          ) : null}
          {routineUnrestricted(routine) ? (
            <HoverTip
              tip="This routine runs with full access: when it fires, June can run commands and change any file your account can. Routines without this badge run sandboxed and cannot touch your files."
              className="routine-meta-pill routine-meta-pill-warm"
              tabIndex={0}
            >
              <IconShieldCrossed size={11} aria-hidden />
              Unrestricted
            </HoverTip>
          ) : null}
          {paused ? (
            <span className="routine-meta-pill" aria-label="Paused">
              <IconPause size={12} aria-hidden />
              Paused
            </span>
          ) : null}
          {completed ? <span className="routine-meta-pill">Completed</span> : null}
          <span className="routine-meta-pill">
            <IconCalendarRepeat size={12} aria-hidden />
            {storedTrigger
              ? TRIGGER_META[storedTrigger.kind].label
              : compactScheduleLabel(routine.schedule)}
          </span>
          {completed && routine.last_run_at ? (
            <span className="routine-meta-pill">Last ran {formatRunTime(routine.last_run_at)}</span>
          ) : null}
        </div>

        {error ? (
          <div className="error-banner routines-error-banner" role="alert">
            <p>{error}</p>
            {onRetryLoad ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onRetryLoad}
                disabled={retrying}
                aria-busy={retrying || undefined}
              >
                <IconArrowRotateClockwise size={14} className="balance-refresh-icon" aria-hidden />
                Try again
              </button>
            ) : null}
          </div>
        ) : null}
        {failure ? (
          <div className="routine-detail-failure" role="status">
            <strong>Last run failed.</strong> {failure}
          </div>
        ) : null}

        <div
          className="routine-detail-tabs"
          style={
            {
              "--routine-tabs-indicator-x": `${tabIndicator.x}px`,
              "--routine-tabs-indicator-w": `${tabIndicator.width}px`,
            } as CSSProperties
          }
          role="tablist"
          aria-label="Routine sections"
        >
          <button
            ref={detailsTabRef}
            id="routine-details-tab"
            type="button"
            role="tab"
            aria-selected={activeTab === "details"}
            aria-controls="routine-details-panel"
            onClick={() => setActiveTab("details")}
          >
            Details
          </button>
          <button
            ref={historyTabRef}
            id="routine-history-tab"
            type="button"
            role="tab"
            aria-selected={activeTab === "history"}
            aria-controls="routine-history-panel"
            onClick={() => setActiveTab("history")}
          >
            Run history
          </button>
        </div>

        {activeTab === "details" ? (
          <div
            id="routine-details-panel"
            className="routine-detail-body"
            role="tabpanel"
            aria-labelledby="routine-details-tab"
          >
            <section className="settings-group" aria-labelledby="routine-schedule">
              <h2 id="routine-schedule" className="settings-group-heading">
                When
              </h2>
              <div className="settings-card">
                <TriggerPicker
                  trigger={trigger}
                  scheduleDraft={draft}
                  hasAccount={accounts.some((entry) => entry.status === "connected")}
                  onTriggerChange={setTrigger}
                  onScheduleChange={setDraft}
                />
              </div>
            </section>

            <section className="settings-group" aria-labelledby="routine-instructions">
              <h2 id="routine-instructions" className="settings-group-heading">
                Instructions
              </h2>
              <GrowingTextarea
                className="routine-detail-instructions"
                value={prompt}
                aria-label="Instructions"
                onChange={(event) => setPrompt(event.currentTarget.value)}
              />
            </section>

            <section className="settings-group" aria-labelledby="routine-access">
              <h2 id="routine-access" className="settings-group-heading">
                Access
              </h2>
              <div className="settings-card">
                <RoutineModePicker unrestricted={unrestricted} onChange={setUnrestricted} />
                {routine.script ? (
                  <p className="routine-detail-script-note">
                    This routine has an attached script ({routine.script}) that runs outside the
                    sandbox, so it always has full access. Switching it to Sandboxed removes the
                    script when you save.
                  </p>
                ) : null}
              </div>
            </section>

            <section className="settings-group" aria-labelledby="routine-trust">
              <h2 id="routine-trust" className="settings-group-heading">
                Actions
              </h2>
              <div className="settings-card">
                <TrustModePicker
                  value={trustMode}
                  runCount={storedTrust?.approvalRunCount ?? 0}
                  autonomousTools={autonomousTools}
                  onChange={setTrustMode}
                  onAutonomousToolsChange={setAutonomousTools}
                />
              </div>
            </section>
          </div>
        ) : (
          <section
            id="routine-history-panel"
            className="routine-detail-body"
            role="tabpanel"
            aria-labelledby="routine-history-tab"
            aria-label="Run history"
          >
            {runs.length > 0 ? (
              <div className="settings-card routines-runs-card">
                <RoutineRunList runs={runs} label={() => routine.name} onOpen={onOpenRun} />
              </div>
            ) : (
              <p className="routines-runs-empty">
                No runs yet. When this routine fires, its session appears here.
              </p>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
