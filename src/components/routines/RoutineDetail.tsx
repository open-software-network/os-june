import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconCalendarRepeat } from "central-icons/IconCalendarRepeat";
import { IconPlay } from "central-icons/IconPlay";
import { IconShieldCrossed } from "central-icons/IconShieldCrossed";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { IconPause as IconPauseFilled } from "central-icons-filled/IconPause";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
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
import type { HermesSessionInfo } from "../../lib/tauri";
import { BreadcrumbBar } from "../ui/BreadcrumbBar";
import { HoverTip } from "../ui/HoverTip";
import { Switch } from "../ui/Switch";
import { GrowingTextarea } from "./GrowingTextarea";
import { RoutineModePicker } from "./RoutineModePicker";
import { formatRunTime, RoutineRunList } from "./RoutineRunList";
import { SchedulePicker } from "./SchedulePicker";

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
}: RoutineDetailProps) {
  const [name, setName] = useState(routine.name);
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    draftFromSchedule(routine.schedule),
  );
  const [prompt, setPrompt] = useState(routine.prompt);
  const [unrestricted, setUnrestricted] = useState(() =>
    routineUnrestricted(routine),
  );
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
      const tab =
        activeTab === "details" ? detailsTabRef.current : historyTabRef.current;
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
    JSON.stringify(draft) !==
    JSON.stringify(draftFromSchedule(routine.schedule));
  const promptChanged = prompt !== routine.prompt;
  const modeChanged = unrestricted !== routineUnrestricted(routine);
  const dirty = nameChanged || scheduleChanged || promptChanged || modeChanged;

  async function save() {
    const updates: RoutineUpdates = {};
    if (nameChanged) updates.name = name.trim();
    if (scheduleChanged) updates.schedule = scheduleFromDraft(draft);
    if (promptChanged) updates.prompt = prompt;
    if (modeChanged) updates.unrestricted = unrestricted;
    await onSave(updates);
  }

  async function runNow() {
    await onRunNow();
    setQueued(true);
    window.clearTimeout(queueTimer.current);
    queueTimer.current = window.setTimeout(() => setQueued(false), 5000);
  }

  const failure =
    routine.last_status === "error"
      ? routine.last_error || routine.last_delivery_error
      : null;

  return (
    <section className="routine-detail" aria-label={routine.name}>
      <BreadcrumbBar
        backLabel="Back to routines"
        onBack={onBack}
        items={[
          { label: "Routines", onClick: onBack },
          { label: name.trim() || routine.name },
        ]}
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
                <div
                  className="sidebar-identity-menu agent-session-menu"
                  role="menu"
                >
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
            <span className="routine-meta-pill routine-meta-pill-warm">
              Active
            </span>
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
              <IconPauseFilled size={12} aria-hidden />
              Paused
            </span>
          ) : null}
          {completed ? (
            <span className="routine-meta-pill">Completed</span>
          ) : null}
          <span className="routine-meta-pill">
            <IconCalendarRepeat size={12} aria-hidden />
            {compactScheduleLabel(routine.schedule)}
          </span>
          {completed && routine.last_run_at ? (
            <span className="routine-meta-pill">
              Last ran {formatRunTime(routine.last_run_at)}
            </span>
          ) : null}
        </div>

        {error ? <p className="error-banner">{error}</p> : null}
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
            <section
              className="settings-group"
              aria-labelledby="routine-schedule"
            >
              <h2 id="routine-schedule" className="settings-group-heading">
                Schedule
              </h2>
              <div className="settings-card">
                <SchedulePicker draft={draft} onChange={setDraft} />
              </div>
            </section>

            <section
              className="settings-group"
              aria-labelledby="routine-instructions"
            >
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

            <section
              className="settings-group"
              aria-labelledby="routine-access"
            >
              <h2 id="routine-access" className="settings-group-heading">
                Access
              </h2>
              <div className="settings-card">
                <RoutineModePicker
                  unrestricted={unrestricted}
                  onChange={setUnrestricted}
                />
                {routine.script ? (
                  <p className="routine-detail-script-note">
                    This routine has an attached script ({routine.script}) that
                    runs outside the sandbox, so it always has full access.
                    Switching it to Sandboxed removes the script when you save.
                  </p>
                ) : null}
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
                <RoutineRunList
                  runs={runs}
                  label={(run) => run.title?.trim() || routine.name}
                  onOpen={onOpenRun}
                />
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
