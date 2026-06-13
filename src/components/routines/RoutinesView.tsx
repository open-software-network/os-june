import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconCalendarRepeat } from "central-icons/IconCalendarRepeat";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPencil } from "central-icons/IconPencil";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconPlay } from "central-icons/IconPlay";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconShieldCrossed } from "central-icons/IconShieldCrossed";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { IconZap } from "central-icons/IconZap";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listScheduledRunSessions,
  scheduledRunJobId,
} from "../../lib/hermes-adapter";
import {
  createRoutine,
  listRoutines,
  pauseRoutine,
  removeRoutine,
  resumeRoutine,
  routineCreationPrompt,
  routineUnrestricted,
  triggerRoutine,
  updateRoutine,
  type RoutineJob,
  type RoutineUpdates,
} from "../../lib/hermes-routines";
import {
  compactScheduleLabel,
  humanizeSchedule,
} from "../../lib/routine-schedule";
import { useForcedEmptyStates } from "../../lib/empty-states-demo";
import type { HermesSessionInfo } from "../../lib/tauri";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { HoverTip } from "../ui/HoverTip";
import { RoutineCreate, type RoutineCreateInput } from "./RoutineCreate";
import { RoutineDetail } from "./RoutineDetail";
import { formatRunTime, RoutineRunList } from "./RoutineRunList";
import { ROUTINE_TEMPLATES, type RoutineTemplate } from "./routine-templates";

const NO_ROUTINES: RoutineJob[] = [];
const NO_RUNS: HermesSessionInfo[] = [];

type RoutinesViewProps = {
  /** The chat-first creation path: hands off a composed agent prompt and the
   * app opens a new June session with it, so the agent does the cron-job
   * setup (naming, scheduling) from a plain description. */
  onCreateRoutine: (prompt: string) => void;
  /** Opens a past run (a cron-sourced Hermes session) in the agent view. */
  onOpenRun: (session: HermesSessionInfo) => void;
};

type Page =
  | { kind: "list" }
  | { kind: "create"; template?: RoutineTemplate }
  | { kind: "detail"; jobId: string };

export function RoutinesView({
  onCreateRoutine,
  onOpenRun,
}: RoutinesViewProps) {
  const [allRoutines, setRoutines] = useState<RoutineJob[]>([]);
  const [loadingState, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<RoutineJob | null>(null);
  const [page, setPage] = useState<Page>({ kind: "list" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [describeDraft, setDescribeDraft] = useState("");
  const [refreshSpins, setRefreshSpins] = useState(0);
  // Per-routine mode choice for the routine being described. Defaults to
  // sandboxed on every open: like the chat picker, Unrestricted is a
  // deliberate per-creation opt-in, never a sticky preference.
  const [describeUnrestricted, setDescribeUnrestricted] = useState(false);
  const [allRuns, setRuns] = useState<HermesSessionInfo[]>([]);
  const [runsUnavailableState, setRunsUnavailable] = useState(false);

  // __emptyStates() preview (dev console): render the page as a fresh
  // install would see it, real data untouched underneath.
  const forcedEmpty = useForcedEmptyStates();
  const routines = forcedEmpty ? NO_ROUTINES : allRoutines;
  const runs = forcedEmpty ? NO_RUNS : allRuns;
  const loading = !forcedEmpty && loadingState;
  const runsUnavailable = !forcedEmpty && runsUnavailableState;

  // `loading` gates the whole list and only covers the first fetch;
  // `refreshing` covers every fetch so reloads keep the list visible while
  // still signalling progress on the refresh control.
  const loadRoutines = useCallback(async () => {
    setRefreshing(true);
    try {
      const jobs = await listRoutines();
      setRoutines(sortRoutines(jobs));
      setError(null);
      return null;
    } catch (err) {
      const message = messageFromError(err);
      setError(message);
      return message;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Run history comes from a different backend (the session store, not the
  // cron manager), so its failure must not take the routines list down with
  // it — it degrades to a quiet notice inside the section instead.
  const loadRuns = useCallback(async () => {
    try {
      setRuns(await listScheduledRunSessions());
      setRunsUnavailable(false);
    } catch {
      setRunsUnavailable(true);
    }
  }, []);

  const refresh = useCallback(
    () => Promise.all([loadRoutines(), loadRuns()]),
    [loadRoutines, loadRuns],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return routines;
    return routines.filter((routine) =>
      // Match the displayed wording too, so "weekdays" finds a routine whose
      // stored schedule is "0 9 * * 1-5".
      `${routine.name} ${routine.prompt_preview} ${routine.schedule} ${humanizeSchedule(routine.schedule)} ${compactScheduleLabel(routine.schedule)}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [routines, query]);

  const routinesById = useMemo(
    () => new Map(routines.map((routine) => [routine.job_id, routine])),
    [routines],
  );

  // A run is labeled with its routine's current name; once the routine is
  // deleted, the session's own derived title is the best label left.
  const runLabel = useCallback(
    (run: HermesSessionInfo) => {
      const jobId = scheduledRunJobId(run.id);
      const routine = jobId ? routinesById.get(jobId) : undefined;
      return routine?.name || run.title?.trim() || "Routine run";
    },
    [routinesById],
  );

  const filteredRuns = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return runs;
    return runs.filter((run) =>
      `${runLabel(run)} ${run.title ?? ""} ${run.preview ?? ""}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [runs, query, runLabel]);

  function markBusy(jobId: string, busy: boolean) {
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  }

  async function toggleActive(routine: RoutineJob) {
    markBusy(routine.job_id, true);
    try {
      if (routine.state === "paused") await resumeRoutine(routine.job_id);
      else await pauseRoutine(routine.job_id);
      // loadRoutines manages the error banner itself (clears on success,
      // sets on failure) — clearing here would mask a failed reload.
      const reloadError = await loadRoutines();
      setDetailError(reloadError);
    } catch (err) {
      setError(messageFromError(err));
      setDetailError(messageFromError(err));
    } finally {
      markBusy(routine.job_id, false);
    }
  }

  async function runNow(routine: RoutineJob) {
    markBusy(routine.job_id, true);
    try {
      await triggerRoutine(routine.job_id);
      setDetailError(null);
    } catch (err) {
      setDetailError(messageFromError(err));
      throw err;
    } finally {
      markBusy(routine.job_id, false);
    }
  }

  async function saveRoutine(jobId: string, updates: RoutineUpdates) {
    setSaving(true);
    try {
      await updateRoutine(jobId, updates);
      await loadRoutines();
      setDetailError(null);
    } catch (err) {
      setDetailError(messageFromError(err));
    } finally {
      setSaving(false);
    }
  }

  async function submitCreate(input: RoutineCreateInput) {
    setCreating(true);
    try {
      const created = await createRoutine(input);
      await loadRoutines();
      setCreateError(null);
      setDetailError(null);
      setPage({ kind: "detail", jobId: created.job_id });
    } catch (err) {
      setCreateError(messageFromError(err));
    } finally {
      setCreating(false);
    }
  }

  async function confirmDelete() {
    const routine = pendingDelete;
    if (!routine) return;
    // ConfirmDialog swallows a thrown error (it only keeps itself open), so
    // route failures to the banner like toggleActive does instead.
    try {
      await removeRoutine(routine.job_id);
      setRoutines((prev) =>
        prev.filter((entry) => entry.job_id !== routine.job_id),
      );
      setError(null);
      setPage((current) =>
        current.kind === "detail" && current.jobId === routine.job_id
          ? { kind: "list" }
          : current,
      );
    } catch (err) {
      setError(messageFromError(err));
      setDetailError(messageFromError(err));
    }
  }

  function submitDescribe() {
    const description = describeDraft.trim();
    if (!description) return;
    setDescribeDraft("");
    onCreateRoutine(
      routineCreationPrompt(description, {
        unrestricted: describeUnrestricted,
      }),
    );
  }

  function openCreate(template?: RoutineTemplate) {
    setCreateError(null);
    setPage({ kind: "create", template });
  }

  function openDetail(routine: RoutineJob) {
    setDetailError(null);
    setPage({ kind: "detail", jobId: routine.job_id });
  }

  function refreshNow() {
    setRefreshSpins((spins) => spins + 1);
    void refresh();
  }

  const detailRoutine =
    page.kind === "detail" ? (routinesById.get(page.jobId) ?? null) : null;

  // A detail page whose routine vanished (deleted from another surface,
  // emptied by a reload) falls back to the list instead of a dead end.
  useEffect(() => {
    if (page.kind === "detail" && !loading && !detailRoutine) {
      setPage({ kind: "list" });
    }
  }, [page.kind, loading, detailRoutine]);

  // The describe bar is the chat composer, anchored to the bottom of the
  // panel like the agent session pages — always there, so describing a
  // routine to June never needs a button first.
  const describeBar = (
    <DescribeBar
      draft={describeDraft}
      unrestricted={describeUnrestricted}
      onDraftChange={setDescribeDraft}
      onUnrestrictedChange={setDescribeUnrestricted}
      onSubmit={submitDescribe}
    />
  );

  const dialogs = (
    <>
      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title={`Delete “${pendingDelete?.name ?? ""}”?`}
        description="June will stop running this routine. This can’t be undone."
        confirmLabel="Delete"
        destructive
      />
    </>
  );

  if (page.kind === "create") {
    return (
      <>
        <RoutineCreate
          template={page.template}
          creating={creating}
          error={createError}
          onBack={() => setPage({ kind: "list" })}
          onCreate={(input) => void submitCreate(input)}
        />
        {describeBar}
        {dialogs}
      </>
    );
  }

  if (page.kind === "detail" && detailRoutine) {
    const routineRuns = runs.filter(
      (run) => scheduledRunJobId(run.id) === detailRoutine.job_id,
    );
    return (
      <>
        <RoutineDetail
          key={detailRoutine.job_id}
          routine={detailRoutine}
          runs={routineRuns}
          busy={busyIds.has(detailRoutine.job_id)}
          saving={saving}
          error={detailError}
          onBack={() => setPage({ kind: "list" })}
          onSave={(updates) => saveRoutine(detailRoutine.job_id, updates)}
          onToggleActive={() => void toggleActive(detailRoutine)}
          onRunNow={() => runNow(detailRoutine)}
          onDelete={() => setPendingDelete(detailRoutine)}
          onOpenRun={onOpenRun}
        />
        {dialogs}
      </>
    );
  }

  return (
    <section className="routines-workspace" aria-label="Routines">
      <header className="folders-header">
        <div className="folders-heading">
          <h1>
            Routines
            {routines.length > 0 ? (
              <span className="folders-count">{routines.length}</span>
            ) : null}
          </h1>
          <p className="folders-subtitle">
            Automations June runs for you on a schedule.
          </p>
        </div>
        <button
          type="button"
          className="primary-action primary-solid"
          onClick={() => openCreate()}
        >
          <IconPlusMedium size={13} />
          New routine
        </button>
      </header>

      {routines.length > 0 ? (
        <div className="folders-controls">
          <label className="folders-search">
            <IconMagnifyingGlass size={14} />
            <input
              type="search"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <button
            type="button"
            className="icon-button routines-refresh"
            aria-label="Refresh"
            aria-busy={refreshing}
            disabled={refreshing}
            title="Refresh"
            onClick={refreshNow}
          >
            <IconArrowRotateClockwise
              size={14}
              className="balance-refresh-icon"
              style={{ transform: `rotate(${refreshSpins * 360}deg)` }}
            />
          </button>
        </div>
      ) : null}

      {error ? <p className="error-banner">{error}</p> : null}

      {loading ? (
        <div className="folders-empty">
          <p>Loading routines…</p>
        </div>
      ) : routines.length === 0 ? (
        <div className="routines-hero">
          <TemplateGrid onPick={openCreate} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="folders-empty">
          <p>No routines match “{query.trim()}”.</p>
        </div>
      ) : (
        <ul className="routines-list" role="list" aria-label="Routines">
          {filtered.map((routine) => (
            <RoutineRow
              key={routine.job_id}
              routine={routine}
              busy={busyIds.has(routine.job_id)}
              onOpen={() => openDetail(routine)}
              onRunNow={() =>
                void runNow(routine).catch((err) =>
                  setError(messageFromError(err)),
                )
              }
              onDelete={() => setPendingDelete(routine)}
            />
          ))}
        </ul>
      )}

      {/* Hidden while everything is empty (the hero owns the page) and while
       * a search matches no runs; shown otherwise, including when only
       * orphaned runs of deleted routines remain. */}
      {!loading &&
      (query.trim()
        ? filteredRuns.length > 0
        : routines.length > 0 || runs.length > 0 || runsUnavailable) ? (
        <section className="routines-runs" aria-label="Run history">
          <header className="routines-runs-header">
            <h2>
              Run history
              {runs.length > 0 ? (
                <span className="folders-count">{runs.length}</span>
              ) : null}
            </h2>
          </header>
          {runsUnavailable ? (
            <p className="routines-runs-empty">
              Run history is unavailable right now.
            </p>
          ) : runs.length === 0 ? (
            <p className="routines-runs-empty">
              No runs yet. When a routine fires, its session appears here.
            </p>
          ) : (
            <div className="routines-runs-panel">
              <RoutineRunList
                runs={filteredRuns}
                label={runLabel}
                onOpen={onOpenRun}
              />
            </div>
          )}
        </section>
      ) : null}

      {!loading && routines.length > 0 && !query.trim() ? (
        <section className="routines-starters" aria-label="Starter routines">
          <header className="routines-section-header">
            <h2>Starter routines</h2>
          </header>
          <TemplateGrid onPick={openCreate} />
        </section>
      ) : null}

      {describeBar}
      {dialogs}
    </section>
  );
}

function TemplateGrid({
  onPick,
}: {
  onPick: (template: RoutineTemplate) => void;
}) {
  return (
    <ul className="routines-template-grid" role="list">
      {ROUTINE_TEMPLATES.map((template) => (
        <li key={template.id} className="routines-template-card">
          <span className="routines-template-icon" aria-hidden>
            <template.icon size={15} />
          </span>
          <div className="routines-template-body">
            <span className="routines-template-name">
              {template.name}
              {template.unrestricted ? (
                // The list rows spell the badge out; cards just flash the
                // warm shield and let the tip carry the explanation.
                <HoverTip
                  tip="This starter needs full access: when it fires, June can run commands and change any file your account can. You confirm that before creating it."
                  className="routines-item-badge routines-item-badge-warm routines-badge-compact"
                  tabIndex={0}
                  aria-label="Unrestricted"
                >
                  <IconShieldCrossed size={11} aria-hidden />
                </HoverTip>
              ) : null}
            </span>
            <p className="routines-template-description">
              {template.description}
            </p>
          </div>
          <button
            type="button"
            className="icon-button routines-template-add"
            aria-label={`Add ${template.name}`}
            onClick={() => onPick(template)}
          >
            <IconPlusMedium size={13} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

function RoutineRow({
  routine,
  busy,
  onOpen,
  onRunNow,
  onDelete,
}: {
  routine: RoutineJob;
  busy: boolean;
  onOpen: () => void;
  onRunNow: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const paused = routine.state === "paused";
  const completed = routine.state === "completed";
  const status = paused ? "Paused" : completed ? "Completed" : null;
  const activity =
    completed && routine.last_run_at
      ? `Last ran ${formatRunTime(routine.last_run_at)}`
      : null;

  useEffect(() => {
    if (!menuOpen) return;
    function close(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <li
      className="routines-item"
      data-state={routine.state}
      data-menu-open={menuOpen || undefined}
    >
      <button type="button" className="routines-item-open" onClick={onOpen}>
        <span className="routines-item-icon" aria-hidden>
          <IconZap size={14} />
        </span>
        <span className="routines-item-body">
          <span className="routines-item-title">
            <span className="routines-item-name">{routine.name}</span>
            {routineUnrestricted(routine) ? (
              <HoverTip
                tip="This routine runs with full access: when it fires, June can run commands and change any file your account can. Routines without this badge run sandboxed and cannot touch your files."
                className="routines-item-badge routines-item-badge-warm"
                tabIndex={0}
              >
                <IconShieldCrossed size={11} aria-hidden />
                Unrestricted
              </HoverTip>
            ) : null}
            {routine.last_status === "error" ? (
              <span className="routines-item-badge routines-item-badge-error">
                Last run failed
              </span>
            ) : null}
          </span>
        </span>
        <span className="routines-item-meta" aria-label="Routine metadata">
          <span className="routine-meta-pill">
            <IconCalendarRepeat size={12} aria-hidden />
            {compactScheduleLabel(routine.schedule)}
          </span>
          {activity ? (
            <span className="routine-meta-pill">{activity}</span>
          ) : null}
          {status ? <span className="routine-meta-pill">{status}</span> : null}
        </span>
      </button>
      <span className="routines-item-actions">
        <span className="routines-item-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="icon-button routines-item-menu-trigger"
            aria-label={`Actions for ${routine.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <IconDotGrid1x3Horizontal size={13} />
          </button>
          {menuOpen ? (
            <span
              className="sidebar-identity-menu routines-action-menu"
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpen();
                }}
              >
                <IconPencil size={14} />
                Edit
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={busy || routine.state !== "scheduled"}
                onClick={() => {
                  setMenuOpen(false);
                  onRunNow();
                }}
              >
                <IconPlay size={14} />
                Run now
              </button>
              <span className="context-menu-separator" role="separator" />
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
            </span>
          ) : null}
        </span>
      </span>
    </li>
  );
}

/** Active routines first (soonest run on top), then paused, then completed. */
function sortRoutines(jobs: RoutineJob[]) {
  const rank = { scheduled: 0, paused: 1, completed: 2 } as const;
  return [...jobs].sort((left, right) => {
    const byState = (rank[left.state] ?? 0) - (rank[right.state] ?? 0);
    if (byState !== 0) return byState;
    return timeValue(left.next_run_at) - timeValue(right.next_run_at);
  });
}

function timeValue(iso: string | null | undefined) {
  if (!iso) return Number.MAX_SAFE_INTEGER;
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? Number.MAX_SAFE_INTEGER : time;
}

function messageFromError(err: unknown) {
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "Routines are unavailable. Is June's agent running?";
}

const DESCRIBE_MODE_OPTIONS = [
  {
    unrestricted: false,
    icon: <IconShieldCheck size={16} aria-hidden />,
    title: "Sandboxed",
    description:
      "The routine can read the web and memory but cannot touch your files.",
  },
  {
    unrestricted: true,
    icon: <IconShieldCrossed size={16} aria-hidden />,
    title: "Unrestricted",
    description: "When it fires, June can change any file your account can.",
  },
] as const;

/** The chat experience as the routines pages' bottom bar: the agent
 * composer's box, sandbox trigger, and send arrow (same classes, same
 * affordances), permanently anchored like on the agent session pages.
 * Submitting hands the description off to a real June session that sets the
 * routine up. */
function DescribeBar({
  draft,
  unrestricted,
  onDraftChange,
  onUnrestrictedChange,
  onSubmit,
}: {
  draft: string;
  unrestricted: boolean;
  onDraftChange: (draft: string) => void;
  onUnrestrictedChange: (unrestricted: boolean) => void;
  onSubmit: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLFormElement>(null);

  // The sandbox menu dismisses on any outside click, like the composer's
  // own popovers.
  useEffect(() => {
    if (!menuOpen) return;
    function onPointer(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
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

  return (
    <div className="routines-describe">
      <form
        ref={rootRef}
        className="routines-describe-composer"
        aria-label="Describe a routine to June"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="agent-composer-box">
          <textarea
            rows={1}
            value={draft}
            placeholder="Have June help you set up a routine"
            onChange={(event) => onDraftChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="agent-composer-toolbar">
            <button
              type="button"
              className="agent-sandbox-trigger"
              data-unrestricted={unrestricted ? "true" : undefined}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="Change what this routine can touch"
              onClick={() => setMenuOpen((open) => !open)}
            >
              {unrestricted ? (
                <IconShieldCrossed size={14} aria-hidden />
              ) : (
                <IconShieldCheck size={14} aria-hidden />
              )}
              {unrestricted ? "Unrestricted" : "Sandboxed"}
              <IconChevronDownSmall size={12} aria-hidden />
            </button>
            <div className="agent-composer-actions">
              <button
                type="submit"
                className="agent-composer-send"
                disabled={!draft.trim()}
                aria-label="Ask June to set it up"
              >
                <IconArrowUp size={16} />
              </button>
            </div>
          </div>
        </div>
        {menuOpen ? (
          <div
            className="agent-sandbox-menu"
            role="menu"
            aria-label="What can this routine change?"
          >
            <p className="agent-sandbox-menu-title">
              What can this routine change?
            </p>
            {DESCRIBE_MODE_OPTIONS.map((option) => (
              <button
                key={option.title}
                type="button"
                role="menuitemradio"
                aria-checked={unrestricted === option.unrestricted}
                onClick={() => {
                  setMenuOpen(false);
                  onUnrestrictedChange(option.unrestricted);
                }}
              >
                {option.icon}
                <span className="agent-sandbox-option">
                  <span className="agent-sandbox-option-title">
                    {option.title}
                  </span>
                  <span className="agent-sandbox-option-desc">
                    {option.description}
                  </span>
                </span>
                {unrestricted === option.unrestricted ? (
                  <IconCheckmark1Small
                    size={16}
                    aria-hidden
                    className="agent-sandbox-option-check"
                  />
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </form>
    </div>
  );
}
