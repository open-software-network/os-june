import { listen } from "@tauri-apps/api/event";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconClock } from "central-icons/IconClock";
import { IconPause } from "central-icons/IconPause";
import { IconPlay } from "central-icons/IconPlay";
import { IconRunShortcut } from "central-icons/IconRunShortcut";
import { IconStop } from "central-icons/IconStop";
import { useCallback, useEffect, useRef, useState } from "react";
import { messageFromError } from "../../lib/errors";
import {
  buildFocusIntervalPlan,
  focusClock,
  focusPlanMinutes,
  focusProjectAllocations,
  formatFocusDuration,
  midpointTimestamp,
} from "../../lib/focus";
import { isMacLikePlatform } from "../../lib/platform";
import {
  focusAbandon,
  focusFinish,
  focusHistory,
  focusListMacosShortcuts,
  focusPause,
  focusReassignSegment,
  focusResume,
  focusSplitSegment,
  focusStart,
  focusStartPlan,
  focusStartBreak,
  focusStatus,
  focusUpdateCompletion,
  focusUpdateNextProject,
  type FocusSegmentDto,
  type FocusSessionDto,
  type FolderDto,
  type StartFocusRequest,
} from "../../lib/tauri";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState } from "../ui/EmptyState";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Select } from "../ui/Select";

const NO_PROJECT = "__none__";
const NO_SHORTCUT = "";
const FOCUS_CHANGED_EVENT = "june:focus:changed";
const FOCUS_SHORTCUT_ERROR_EVENT = "june:focus:shortcut-error";
const FOCUS_DURATION_PRESETS = [25, 40, 50, 90];

type FocusView = "focus" | "history";
type PlanKind = "single" | "intervals";

export function FocusWorkspace({ projects }: { projects: FolderDto[] }) {
  const [view, setView] = useState<FocusView>("focus");
  const [active, setActive] = useState<FocusSessionDto | null>(null);
  const [history, setHistory] = useState<FocusSessionDto[]>([]);
  const [selected, setSelected] = useState<FocusSessionDto>();
  const [snapshotAt, setSnapshotAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [historyProject, setHistoryProject] = useState(NO_PROJECT);

  const refreshActive = useCallback(async () => {
    const next = await focusStatus();
    setActive(next);
    setSnapshotAt(Date.now());
    return next;
  }, []);

  const refreshHistory = useCallback(async () => {
    const sessions = await focusHistory({
      projectId: historyProject === NO_PROJECT ? undefined : historyProject,
      limit: 100,
    });
    setHistory(sessions);
    setSelected((current) =>
      current ? sessions.find((session) => session.id === current.id) : current,
    );
  }, [historyProject]);

  useEffect(() => {
    let disposed = false;
    void Promise.all([focusStatus(), focusHistory({ limit: 100 })])
      .then(([nextActive, sessions]) => {
        if (disposed) return;
        setActive(nextActive);
        setHistory(sessions);
        setSnapshotAt(Date.now());
      })
      .catch((reason) => {
        if (!disposed) setError(messageFromError(reason));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    const unlisteners = Promise.all([
      listen(FOCUS_CHANGED_EVENT, () => {
        void refreshActive().then((next) => {
          if (!next) void refreshHistory();
        });
      }),
      listen<{ message: string }>(FOCUS_SHORTCUT_ERROR_EVENT, (event) => {
        setError(event.payload.message);
      }),
    ]);
    return () => {
      disposed = true;
      void unlisteners.then((items) =>
        items.forEach((unlisten) => {
          unlisten();
        }),
      );
    };
  }, [refreshActive, refreshHistory]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!loading) {
      void refreshHistory().catch((reason) => setError(messageFromError(reason)));
    }
  }, [loading, refreshHistory]);

  async function runAction(
    action: () => Promise<FocusSessionDto>,
    terminal = false,
    propagate = false,
  ) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const session = await action();
      if (terminal) {
        setActive(null);
        setSelected(session);
        setView("history");
        await refreshHistory();
      } else {
        setActive(session);
        setSnapshotAt(Date.now());
      }
    } catch (reason) {
      setError(messageFromError(reason));
      if (propagate) throw reason;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="focus-workspace" aria-label="Focus">
      <header className="focus-header">
        <div>
          <p className="focus-eyebrow">June Focus</p>
          <h1>Make time for one clear intention</h1>
          <p>Plan locally, stay with the work, and keep an honest timeline.</p>
        </div>
        <SegmentedControl
          value={view}
          onValueChange={setView}
          aria-label="Focus view"
          options={[
            { value: "focus", label: "Focus" },
            { value: "history", label: "History" },
          ]}
        />
      </header>

      {error ? (
        <p className="error-banner" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="focus-loading" role="status" aria-label="Loading Focus" />
      ) : view === "focus" ? (
        active ? (
          <ActiveFocus
            session={active}
            projects={projects}
            snapshotAt={snapshotAt}
            now={now}
            busy={busy}
            onStart={() => runAction(() => focusStartPlan(active.id))}
            onPause={() => runAction(() => focusPause(active.id))}
            onResume={() => runAction(() => focusResume(active.id))}
            onBreak={() => runAction(() => focusStartBreak(active.id))}
            onFinish={() => runAction(() => focusFinish(active.id), true)}
            onAbandon={() => setConfirmAbandon(true)}
            onNextProject={(projectId) =>
              runAction(() => focusUpdateNextProject({ sessionId: active.id, projectId }))
            }
          />
        ) : (
          <FocusSetup
            projects={projects}
            busy={busy}
            onStart={(request) => runAction(() => focusStart(request))}
          />
        )
      ) : (
        <FocusHistory
          sessions={history}
          selected={selected}
          projects={projects}
          projectFilter={historyProject}
          busy={busy}
          onProjectFilter={setHistoryProject}
          onSelect={setSelected}
          onBack={() => setSelected(undefined)}
          onUpdate={(session) => {
            setSelected(session);
            setHistory((current) =>
              current.map((item) => (item.id === session.id ? session : item)),
            );
          }}
          onError={(reason) => setError(messageFromError(reason))}
          setBusy={setBusy}
        />
      )}

      <ConfirmDialog
        open={confirmAbandon}
        onClose={() => setConfirmAbandon(false)}
        onConfirm={() =>
          active ? runAction(() => focusAbandon(active.id), true, true) : undefined
        }
        title="Abandon this focus session?"
        description="The time already recorded stays in History and is marked abandoned."
        confirmLabel="Abandon session"
        confirmBusyLabel="Abandoning..."
        destructive
      />
    </section>
  );
}

function FocusSetup({
  projects,
  busy,
  onStart,
}: {
  projects: FolderDto[];
  busy: boolean;
  onStart: (request: StartFocusRequest) => Promise<unknown>;
}) {
  const [intention, setIntention] = useState("");
  const [projectId, setProjectId] = useState(NO_PROJECT);
  const [startShortcutName, setStartShortcutName] = useState(NO_SHORTCUT);
  const [shortcutNames, setShortcutNames] = useState<string[]>([]);
  const [shortcutsLoading, setShortcutsLoading] = useState(isMacLikePlatform);
  const [shortcutsUnavailable, setShortcutsUnavailable] = useState(false);
  const [planKind, setPlanKind] = useState<PlanKind>("single");
  const [minutes, setMinutes] = useState(25);
  const [intervalCount, setIntervalCount] = useState(4);
  const [shortBreakMinutes, setShortBreakMinutes] = useState(5);
  const [longBreakMinutes, setLongBreakMinutes] = useState(15);
  const [intervalProjects, setIntervalProjects] = useState<string[]>(() =>
    Array.from({ length: 12 }, () => NO_PROJECT),
  );
  const shortcutRequest = useRef(0);
  const supportsMacosShortcuts = isMacLikePlatform();

  const intervalPlan = buildFocusIntervalPlan({
    intervalCount,
    focusMinutes: minutes,
    shortBreakMinutes,
    longBreakMinutes,
    projectIds: intervalProjects.map((value) => (value === NO_PROJECT ? undefined : value)),
  });
  const plannedMinutes = planKind === "single" ? minutes : focusPlanMinutes(intervalPlan);

  const loadShortcuts = useCallback(async () => {
    const request = shortcutRequest.current + 1;
    shortcutRequest.current = request;
    setShortcutsLoading(true);
    setShortcutsUnavailable(false);
    try {
      const names = await focusListMacosShortcuts();
      if (request !== shortcutRequest.current) return;
      setShortcutNames(names);
      setStartShortcutName((current) =>
        current === NO_SHORTCUT || names.includes(current) ? current : NO_SHORTCUT,
      );
    } catch {
      if (request !== shortcutRequest.current) return;
      setShortcutsUnavailable(true);
    } finally {
      if (request === shortcutRequest.current) setShortcutsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!supportsMacosShortcuts) return;
    void loadShortcuts();
    return () => {
      shortcutRequest.current += 1;
    };
  }, [loadShortcuts, supportsMacosShortcuts]);

  function submit() {
    const intentionValue = intention.trim() || undefined;
    const startShortcut = startShortcutName === NO_SHORTCUT ? {} : { startShortcutName };
    return onStart(
      planKind === "single"
        ? {
            intention: intentionValue,
            ...startShortcut,
            projectId: projectId === NO_PROJECT ? undefined : projectId,
            durationMinutes: minutes,
          }
        : {
            intention: intentionValue,
            ...startShortcut,
            intervalPlan,
          },
    );
  }

  return (
    <div className="focus-setup-grid">
      <form
        className="focus-card focus-setup-card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="focus-section-heading">
          <span className="focus-step">1</span>
          <div>
            <h2>Set your intention</h2>
            <p>Describe the result you want to move forward.</p>
          </div>
        </div>
        <label className="focus-field">
          <span>Intention</span>
          <textarea
            value={intention}
            onChange={(event) => setIntention(event.currentTarget.value)}
            maxLength={500}
            placeholder="Finish the release notes"
            rows={3}
          />
        </label>
        <div className="focus-field">
          <span>Project</span>
          <Select
            value={projectId}
            onChange={(value) => {
              setProjectId(value);
              setIntervalProjects((current) => current.map(() => value));
            }}
            options={projectOptions(projects)}
            placeholder="No Project"
            ariaLabel="Focus Project"
            popoverWidth="trigger"
          />
        </div>
        <div className="focus-section-heading focus-plan-heading">
          <span className="focus-step">2</span>
          <div>
            <h2>Choose a rhythm</h2>
            <p>June keeps the timeline even if the app sleeps or relaunches.</p>
          </div>
        </div>
        <SegmentedControl
          value={planKind}
          onValueChange={setPlanKind}
          aria-label="Focus plan"
          options={[
            { value: "single", label: "Single block" },
            { value: "intervals", label: "Intervals" },
          ]}
        />
        <fieldset className="focus-duration-presets">
          <legend>Duration presets</legend>
          {FOCUS_DURATION_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={minutes === preset}
              onClick={() => setMinutes(preset)}
            >
              {preset} min
            </button>
          ))}
        </fieldset>
        <div className="focus-number-grid">
          <NumberField
            label="Focus minutes"
            value={minutes}
            min={1}
            max={720}
            onChange={setMinutes}
          />
          {planKind === "intervals" ? (
            <>
              <NumberField
                label="Focus intervals"
                value={intervalCount}
                min={1}
                max={12}
                onChange={setIntervalCount}
              />
              <NumberField
                label="Short break minutes"
                value={shortBreakMinutes}
                min={1}
                max={120}
                onChange={setShortBreakMinutes}
              />
              <NumberField
                label="Long break minutes"
                value={longBreakMinutes}
                min={1}
                max={120}
                onChange={setLongBreakMinutes}
              />
            </>
          ) : null}
        </div>
        {planKind === "intervals" ? (
          <div className="focus-plan-builder">
            <div>
              <h3>Interval plan</h3>
              <p>Assign every focus interval to the Project it should move forward.</p>
            </div>
            <ol>
              {intervalPlan.map((interval, position) => {
                const focusIndex = Math.floor(position / 2);
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: interval position is the plan row's stable identity.
                  <li key={`${interval.kind}-${position}`} data-kind={interval.kind}>
                    <span>
                      <strong>
                        {interval.kind === "focus"
                          ? `Focus ${focusIndex + 1}`
                          : (focusIndex + 1) % 4 === 0
                            ? "Long break"
                            : "Short break"}
                      </strong>
                      <small>{interval.durationMinutes} minutes</small>
                    </span>
                    {interval.kind === "focus" ? (
                      <Select
                        value={intervalProjects[focusIndex] || NO_PROJECT}
                        onChange={(value) =>
                          setIntervalProjects((current) =>
                            current.map((project, index) =>
                              index === focusIndex ? value : project,
                            ),
                          )
                        }
                        options={projectOptions(projects)}
                        placeholder="No Project"
                        ariaLabel={`Focus ${focusIndex + 1} Project`}
                        popoverWidth="trigger"
                      />
                    ) : (
                      <span className="focus-plan-break-label">No Project time</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        ) : null}
        <div className="focus-plan-summary">
          <IconClock size={16} ariaHidden />
          <span>
            {planKind === "single"
              ? `${minutes} minute focus block`
              : `${intervalCount} focus blocks with ${Math.max(0, intervalCount - 1)} breaks`}
          </span>
          <strong>{plannedMinutes} minutes planned</strong>
        </div>
        <button type="submit" className="primary-action primary-solid" disabled={busy}>
          <IconPlay size={15} ariaHidden />
          {busy ? "Starting..." : "Start Focus"}
        </button>
      </form>

      <div className="focus-setup-aside">
        {supportsMacosShortcuts ? (
          <aside
            className="focus-card focus-shortcut-card"
            aria-label="Start with a macOS Shortcut"
            aria-busy={shortcutsLoading}
            data-configured={startShortcutName !== NO_SHORTCUT}
          >
            <div className="focus-shortcut-heading">
              <span className="focus-shortcut-icon" aria-hidden>
                <IconRunShortcut size={18} ariaHidden />
              </span>
              <div>
                <h2>Start with a shortcut</h2>
                <p>Optionally run a macOS Shortcut when this session starts.</p>
              </div>
            </div>

            {shortcutsLoading ? (
              <div className="focus-shortcut-loading" role="status">
                Loading shortcuts...
              </div>
            ) : (
              <>
                <div className="focus-field">
                  <span>Shortcut</span>
                  <Select
                    value={startShortcutName}
                    onChange={setStartShortcutName}
                    options={[
                      { value: NO_SHORTCUT, label: "No shortcut" },
                      ...shortcutNames.map((name) => ({ value: name, label: name })),
                    ]}
                    placeholder="No shortcut"
                    ariaLabel="Start shortcut"
                    popoverWidth="trigger"
                  />
                </div>

                {shortcutsUnavailable ? (
                  <div className="focus-shortcut-message" role="status">
                    <p>Your shortcuts could not be loaded.</p>
                    <button type="button" onClick={() => void loadShortcuts()}>
                      Try again
                    </button>
                  </div>
                ) : shortcutNames.length === 0 ? (
                  <div className="focus-shortcut-message" role="status">
                    <p>Create a shortcut in the Shortcuts app, then check again.</p>
                    <button type="button" onClick={() => void loadShortcuts()}>
                      Check again
                    </button>
                  </div>
                ) : (
                  <p className="focus-shortcut-selection" role="status">
                    {startShortcutName === NO_SHORTCUT
                      ? "No shortcut will run for this session."
                      : `${startShortcutName} will run once after Focus starts.`}
                  </p>
                )}
              </>
            )}
          </aside>
        ) : null}

        <aside className="focus-card focus-local-card">
          <IconCheckmark2Small size={18} ariaHidden />
          <h2>Local by default</h2>
          <p>
            Your plan and timeline live in June's on-device database. The timer is derived from
            saved timestamps, so closing the window does not stop it.
          </p>
        </aside>
      </div>
    </div>
  );
}

function ActiveFocus({
  session,
  projects,
  snapshotAt,
  now,
  busy,
  onStart,
  onPause,
  onResume,
  onBreak,
  onFinish,
  onAbandon,
  onNextProject,
}: {
  session: FocusSessionDto;
  projects: FolderDto[];
  snapshotAt: number;
  now: number;
  busy: boolean;
  onStart: () => Promise<unknown>;
  onPause: () => Promise<unknown>;
  onResume: () => Promise<unknown>;
  onBreak: () => Promise<unknown>;
  onFinish: () => Promise<unknown>;
  onAbandon: () => void;
  onNextProject: (projectId?: string) => Promise<unknown>;
}) {
  const clock = focusClock(session, snapshotAt, now);
  const interval = session.intervals.find(
    (item) => item.position === session.currentIntervalPosition,
  );
  const nextFocus = session.intervals.find(
    (item) => item.position > session.currentIntervalPosition && item.kind === "focus",
  );
  const next = session.intervals.find((item) => item.position > session.currentIntervalPosition);
  const status = focusStatusLabel(session.status);
  const canBreak = ["focusing", "overtime"].includes(session.status) && next?.kind === "break";

  return (
    <div className="focus-active-grid">
      <article className="focus-card focus-timer-card" data-status={session.status}>
        <span className="focus-status-chip">{status}</span>
        <p className="focus-timer-label">
          {clock.direction === "up"
            ? "Overtime"
            : session.status === "onBreak"
              ? "Break left"
              : "Time left"}
        </p>
        <strong className="focus-timer-value">{formatFocusDuration(clock.valueMs)}</strong>
        <h2>{session.intention || "Open focus"}</h2>
        <p className="focus-current-project">{interval?.projectName || "No Project"}</p>
        <div className="focus-actions">
          {session.status === "planned" ? (
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={busy}
              onClick={() => void onStart()}
            >
              <IconPlay size={15} ariaHidden /> Start Focus
            </button>
          ) : session.status === "paused" || session.status === "onBreak" ? (
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={busy}
              onClick={() => void onResume()}
            >
              <IconPlay size={15} ariaHidden />
              {session.status === "onBreak" ? "Start next focus" : "Resume"}
            </button>
          ) : (
            <button
              type="button"
              className="primary-action"
              disabled={busy}
              onClick={() => void onPause()}
            >
              <IconPause size={15} ariaHidden /> Pause
            </button>
          )}
          {canBreak ? (
            <button
              type="button"
              className="primary-action"
              disabled={busy}
              onClick={() => void onBreak()}
            >
              Start break
            </button>
          ) : null}
          {session.status !== "planned" ? (
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={busy}
              onClick={() => void onFinish()}
            >
              <IconStop size={15} ariaHidden /> Finish
            </button>
          ) : null}
        </div>
        <button type="button" className="focus-abandon" disabled={busy} onClick={onAbandon}>
          Abandon session
        </button>
      </article>

      <aside className="focus-card focus-progress-card">
        <h2>Plan progress</h2>
        <ol className="focus-interval-list">
          {session.intervals.map((item) => (
            <li
              key={item.position}
              data-current={item.position === session.currentIntervalPosition || undefined}
            >
              <span>{item.kind === "focus" ? "Focus" : "Break"}</span>
              <strong>{formatFocusDuration(item.plannedDurationMs)}</strong>
              <small>{item.projectName || (item.kind === "break" ? "Reset" : "No Project")}</small>
            </li>
          ))}
        </ol>
        {nextFocus ? (
          <div className="focus-next-project">
            <span>Next Focus Project</span>
            <Select
              value={nextFocus.projectId || NO_PROJECT}
              onChange={(value) => void onNextProject(value === NO_PROJECT ? undefined : value)}
              options={projectOptions(projects)}
              placeholder="No Project"
              ariaLabel="Next Focus Project"
              popoverWidth="trigger"
            />
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function FocusHistory({
  sessions,
  selected,
  projects,
  projectFilter,
  busy,
  onProjectFilter,
  onSelect,
  onBack,
  onUpdate,
  onError,
  setBusy,
}: {
  sessions: FocusSessionDto[];
  selected?: FocusSessionDto;
  projects: FolderDto[];
  projectFilter: string;
  busy: boolean;
  onProjectFilter: (value: string) => void;
  onSelect: (session: FocusSessionDto) => void;
  onBack: () => void;
  onUpdate: (session: FocusSessionDto) => void;
  onError: (reason: unknown) => void;
  setBusy: (value: boolean) => void;
}) {
  if (selected) {
    return (
      <FocusHistoryDetail
        session={selected}
        projects={projects}
        busy={busy}
        onBack={onBack}
        onUpdate={onUpdate}
        onError={onError}
        setBusy={setBusy}
      />
    );
  }
  return (
    <div className="focus-history">
      <div className="focus-history-toolbar">
        <div>
          <h2>Focus history</h2>
          <p>Review planned time, actual time, breaks, and corrections.</p>
        </div>
        <Select
          value={projectFilter}
          onChange={onProjectFilter}
          options={[
            { value: NO_PROJECT, label: "All Projects" },
            ...projects.map((project) => ({ value: project.id, label: project.name })),
          ]}
          placeholder="All Projects"
          ariaLabel="Filter Focus history by Project"
        />
      </div>
      {sessions.length === 0 ? (
        <EmptyState
          icon={<IconClock size={20} />}
          title="No focus sessions yet"
          description="Completed and abandoned sessions will appear here with their full local timeline."
        />
      ) : (
        <div className="focus-history-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className="focus-history-row"
              onClick={() => onSelect(session)}
            >
              <span className="focus-history-date">
                {formatFocusDate(session.completedAt || session.abandonedAt || session.createdAt)}
              </span>
              <span>
                <strong>{session.intention || "Open focus"}</strong>
                <small>{historyProjectNames(session)}</small>
              </span>
              <span>{formatFocusDuration(session.actualFocusMs)}</span>
              <span className="focus-outcome" data-outcome={session.outcome}>
                {focusOutcomeLabel(session)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FocusHistoryDetail({
  session,
  projects,
  busy,
  onBack,
  onUpdate,
  onError,
  setBusy,
}: {
  session: FocusSessionDto;
  projects: FolderDto[];
  busy: boolean;
  onBack: () => void;
  onUpdate: (session: FocusSessionDto) => void;
  onError: (reason: unknown) => void;
  setBusy: (value: boolean) => void;
}) {
  const [reflection, setReflection] = useState(session.reflection || "");
  const [quality, setQuality] = useState(session.quality);
  const allocations = focusProjectAllocations(session);

  async function mutate(action: () => Promise<FocusSessionDto>) {
    setBusy(true);
    try {
      onUpdate(await action());
    } catch (reason) {
      onError(reason);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="focus-history-detail">
      <button type="button" className="focus-back" onClick={onBack}>
        Back to history
      </button>
      <header>
        <span className="focus-outcome" data-outcome={session.outcome}>
          {focusOutcomeLabel(session)}
        </span>
        <h2>{session.intention || "Open focus"}</h2>
        <p>{formatFocusDate(session.completedAt || session.abandonedAt || session.createdAt)}</p>
      </header>
      <div className="focus-metrics">
        <FocusMetric label="Planned" value={session.plannedFocusMs} />
        <FocusMetric label="Focused" value={session.actualFocusMs} />
        <FocusMetric label="Breaks" value={session.actualBreakMs} />
        <FocusMetric label="Paused" value={session.pausedMs} />
      </div>
      <section className="focus-card focus-allocation-card">
        <h3>Project allocation</h3>
        <table className="focus-allocation-table" aria-label="Project allocation">
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Planned</th>
              <th scope="col">Focused</th>
            </tr>
          </thead>
          <tbody>
            {allocations.map((item) => (
              <tr key={item.key}>
                <th scope="row">{item.projectName}</th>
                <td>{formatFocusDuration(item.plannedMs)}</td>
                <td>{formatFocusDuration(item.actualMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="focus-card focus-timeline-card">
        <h3>Timeline</h3>
        <div className="focus-timeline">
          {session.segments.map((segment) => (
            <FocusSegmentRow
              key={segment.id}
              segment={segment}
              projects={projects}
              busy={busy}
              onSplit={() => {
                const splitAt = midpointTimestamp(segment.startedAt, segment.endedAt);
                if (splitAt) return mutate(() => focusSplitSegment(segment.id, splitAt));
              }}
              onProject={(projectId) =>
                mutate(() => focusReassignSegment({ segmentId: segment.id, projectId }))
              }
            />
          ))}
        </div>
      </section>
      <section className="focus-card focus-reflection-card">
        <h3>Reflection</h3>
        <label className="focus-field">
          <span>What moved forward?</span>
          <textarea
            value={reflection}
            onChange={(event) => setReflection(event.currentTarget.value)}
            maxLength={2000}
            rows={4}
          />
        </label>
        <fieldset className="focus-quality">
          <legend>Focus quality</legend>
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={quality === value}
              onClick={() => setQuality(value)}
            >
              {value}
            </button>
          ))}
        </fieldset>
        <button
          type="button"
          className="primary-action primary-solid"
          disabled={busy}
          onClick={() =>
            void mutate(() => focusUpdateCompletion({ sessionId: session.id, reflection, quality }))
          }
        >
          Save reflection
        </button>
      </section>
    </div>
  );
}

function FocusSegmentRow({
  segment,
  projects,
  busy,
  onSplit,
  onProject,
}: {
  segment: FocusSegmentDto;
  projects: FolderDto[];
  busy: boolean;
  onSplit: () => Promise<unknown> | undefined;
  onProject: (projectId?: string) => Promise<unknown> | undefined;
}) {
  const carriesProject = segment.kind === "focus" || segment.kind === "overtime";
  return (
    <div className="focus-segment-row" data-kind={segment.kind}>
      <span className="focus-segment-dot" />
      <span>
        <strong>{segmentKindLabel(segment.kind)}</strong>
        <small>{formatSegmentRange(segment)}</small>
      </span>
      <span>{formatFocusDuration(segment.durationMs)}</span>
      {carriesProject ? (
        <Select
          value={segment.projectId || NO_PROJECT}
          onChange={(value) => void onProject(value === NO_PROJECT ? undefined : value)}
          options={projectOptions(projects, segment)}
          placeholder="No Project"
          ariaLabel={`${segmentKindLabel(segment.kind)} Project`}
          popoverWidth="trigger"
        />
      ) : (
        <span className="focus-segment-muted">No Project time</span>
      )}
      {carriesProject && midpointTimestamp(segment.startedAt, segment.endedAt) ? (
        <button
          type="button"
          className="focus-split"
          disabled={busy}
          onClick={() => void onSplit()}
        >
          Split evenly
        </button>
      ) : null}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="focus-field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(event) =>
          onChange(Math.max(min, Math.min(max, Number(event.currentTarget.value) || min)))
        }
      />
    </label>
  );
}

function FocusMetric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{formatFocusDuration(value)}</strong>
    </div>
  );
}

function projectOptions(projects: FolderDto[], segment?: FocusSegmentDto) {
  const options = [
    { value: NO_PROJECT, label: "No Project" },
    ...projects.map((project) => ({ value: project.id, label: project.name })),
  ];
  if (segment?.projectId && !projects.some((project) => project.id === segment.projectId)) {
    options.push({ value: segment.projectId, label: segment.projectName || "Deleted Project" });
  }
  return options;
}

function focusStatusLabel(status: FocusSessionDto["status"]) {
  return {
    planned: "Planned",
    focusing: "Focusing",
    paused: "Paused",
    overtime: "Overtime",
    onBreak: "On break",
    completed: "Completed",
    abandoned: "Abandoned",
  }[status];
}

function focusOutcomeLabel(session: FocusSessionDto) {
  return {
    active: "Active",
    completed: "Completed",
    shortened: "Finished early",
    overtime: "Overtime",
    abandoned: "Abandoned",
  }[session.outcome];
}

function segmentKindLabel(kind: FocusSegmentDto["kind"]) {
  return { focus: "Focus", pause: "Pause", break: "Break", overtime: "Overtime" }[kind];
}

function historyProjectNames(session: FocusSessionDto) {
  const names = [
    ...new Set(session.segments.map((segment) => segment.projectName).filter(Boolean)),
  ];
  return names.length > 0 ? names.join(", ") : "No Project";
}

function formatFocusDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function formatSegmentRange(segment: FocusSegmentDto) {
  const formatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const start = formatter.format(new Date(segment.startedAt));
  const end = segment.endedAt ? formatter.format(new Date(segment.endedAt)) : "now";
  return `${start} to ${end}`;
}
