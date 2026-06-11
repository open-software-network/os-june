import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconArrowsRepeat } from "central-icons/IconArrowsRepeat";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPause } from "central-icons/IconPause";
import { IconPencil } from "central-icons/IconPencil";
import { IconPlay } from "central-icons/IconPlay";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconTrashCanSimple } from "central-icons/IconTrashCanSimple";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listRoutines,
  pauseRoutine,
  removeRoutine,
  resumeRoutine,
  routineCreationPrompt,
  routineEditPrompt,
  type RoutineJob,
} from "../../lib/hermes-routines";
import { humanizeSchedule } from "../../lib/routine-schedule";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";

type RoutinesViewProps = {
  /** Hands off a composed agent prompt; the app opens a new June session with
   * it so the agent does the actual cron-job creation — and, for edits, the
   * cron-job update. */
  onCreateRoutine: (prompt: string) => void;
  onEditRoutine: (prompt: string) => void;
};

export function RoutinesView({
  onCreateRoutine,
  onEditRoutine,
}: RoutinesViewProps) {
  const [routines, setRoutines] = useState<RoutineJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<RoutineJob | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [editTarget, setEditTarget] = useState<RoutineJob | null>(null);
  const [editDraft, setEditDraft] = useState("");

  // `loading` gates the whole list and only covers the first fetch;
  // `refreshing` covers every fetch so reloads keep the list visible while
  // still signalling progress on the refresh control.
  const loadRoutines = useCallback(async () => {
    setRefreshing(true);
    try {
      const jobs = await listRoutines();
      setRoutines(sortRoutines(jobs));
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadRoutines();
  }, [loadRoutines]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return routines;
    return routines.filter((routine) =>
      // Match the displayed wording too, so "weekdays" finds a routine whose
      // stored schedule is "0 9 * * 1-5".
      `${routine.name} ${routine.prompt_preview} ${routine.schedule} ${humanizeSchedule(routine.schedule)}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [routines, query]);

  function markBusy(jobId: string, busy: boolean) {
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  }

  async function togglePaused(routine: RoutineJob) {
    markBusy(routine.job_id, true);
    try {
      if (routine.state === "paused") await resumeRoutine(routine.job_id);
      else await pauseRoutine(routine.job_id);
      // loadRoutines manages the error banner itself (clears on success,
      // sets on failure) — clearing here would mask a failed reload.
      await loadRoutines();
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      markBusy(routine.job_id, false);
    }
  }

  async function confirmDelete() {
    const routine = pendingDelete;
    if (!routine) return;
    // ConfirmDialog swallows a thrown error (it only keeps itself open), so
    // route failures to the banner like togglePaused does instead.
    try {
      await removeRoutine(routine.job_id);
      setRoutines((prev) =>
        prev.filter((entry) => entry.job_id !== routine.job_id),
      );
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  function openCreate() {
    setDraft("");
    setCreateOpen(true);
  }

  function openEdit(routine: RoutineJob) {
    setEditDraft("");
    setEditTarget(routine);
  }

  function submitEdit() {
    const routine = editTarget;
    const changes = editDraft.trim();
    if (!routine || !changes) return;
    setEditTarget(null);
    onEditRoutine(routineEditPrompt(routine, changes));
  }

  function submitCreate() {
    const description = draft.trim();
    if (!description) return;
    setCreateOpen(false);
    onCreateRoutine(routineCreationPrompt(description));
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
          onClick={openCreate}
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
            className="routines-refresh"
            aria-label="Refresh"
            aria-busy={refreshing}
            data-busy={refreshing || undefined}
            disabled={refreshing}
            onClick={() => void loadRoutines()}
          >
            <IconArrowRotateClockwise size={14} />
          </button>
        </div>
      ) : null}

      {error ? <p className="error-banner">{error}</p> : null}

      {loading ? (
        <div className="folders-empty">
          <p>Loading routines…</p>
        </div>
      ) : routines.length === 0 ? (
        <EmptyState
          label="Create your first routine"
          icon={<IconArrowsRepeat size={28} />}
          title="Put June on a schedule"
          description="Describe something June should do every morning, every hour, or at a specific time. A routine runs it for you automatically."
          footer={
            <button
              type="button"
              className="primary-action primary-solid"
              onClick={openCreate}
            >
              <IconPlusMedium size={13} />
              New routine
            </button>
          }
        />
      ) : filtered.length === 0 ? (
        <div className="folders-empty">
          <p>No routines match “{query.trim()}”.</p>
        </div>
      ) : (
        <ul className="routines-list" role="list">
          {filtered.map((routine) => (
            <RoutineRow
              key={routine.job_id}
              routine={routine}
              busy={busyIds.has(routine.job_id)}
              onTogglePaused={() => void togglePaused(routine)}
              onEdit={() => openEdit(routine)}
              onDelete={() => setPendingDelete(routine)}
            />
          ))}
        </ul>
      )}

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        leading={<IconArrowsRepeat size={15} />}
        title="New routine"
        description="Tell June what to do and when. It opens a new session to set the routine up, and you can fine-tune the schedule there."
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={!draft.trim()}
              onClick={submitCreate}
            >
              Ask June to set it up
            </button>
          </>
        }
      >
        <textarea
          className="routines-create-input"
          rows={4}
          placeholder="Every weekday at 9am, summarize my unread notes…"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submitCreate();
            }
          }}
        />
      </Dialog>

      <Dialog
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        leading={<IconPencil size={15} />}
        title={`Edit “${editTarget?.name ?? ""}”`}
        description="Tell June what should change: the schedule, the task, or the name. It opens a session to apply the update."
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setEditTarget(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={!editDraft.trim()}
              onClick={submitEdit}
            >
              Ask June to update it
            </button>
          </>
        }
      >
        <textarea
          className="routines-create-input"
          rows={4}
          placeholder="Run at 7am instead, and only on weekdays…"
          value={editDraft}
          onChange={(event) => setEditDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submitEdit();
            }
          }}
        />
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title={`Delete “${pendingDelete?.name ?? ""}”?`}
        description="June will stop running this routine. This can’t be undone."
        confirmLabel="Delete"
        destructive
      />
    </section>
  );
}

function RoutineRow({
  routine,
  busy,
  onTogglePaused,
  onEdit,
  onDelete,
}: {
  routine: RoutineJob;
  busy: boolean;
  onTogglePaused: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const paused = routine.state === "paused";
  const completed = routine.state === "completed";
  const meta = [
    humanizeSchedule(routine.schedule),
    completed
      ? routine.last_run_at
        ? `Last ran ${formatRunTime(routine.last_run_at)}`
        : null
      : routine.next_run_at
        ? `Next ${formatRunTime(routine.next_run_at)}`
        : null,
  ].filter(Boolean);

  return (
    <li className="routines-item" data-state={routine.state}>
      <span className="routines-item-icon" aria-hidden>
        <IconArrowsRepeat size={14} />
      </span>
      <div className="routines-item-body">
        <span className="routines-item-title">
          <span className="routines-item-name">{routine.name}</span>
          {paused ? <span className="routines-item-badge">Paused</span> : null}
          {completed ? (
            <span className="routines-item-badge">Completed</span>
          ) : null}
          {routine.last_status === "error" ? (
            <span className="routines-item-badge routines-item-badge-error">
              Last run failed
            </span>
          ) : null}
        </span>
        {routine.prompt_preview ? (
          <p className="routines-item-prompt">{routine.prompt_preview}</p>
        ) : null}
      </div>
      <span className="routines-item-meta">{meta.join(" · ")}</span>
      <span className="routines-item-actions">
        <button
          type="button"
          className="dictation-row-act"
          aria-label="Edit"
          disabled={busy}
          onClick={onEdit}
        >
          <IconPencil size={14} />
        </button>
        {!completed ? (
          <button
            type="button"
            className="dictation-row-act"
            aria-label={paused ? "Resume" : "Pause"}
            disabled={busy}
            onClick={onTogglePaused}
          >
            {paused ? <IconPlay size={14} /> : <IconPause size={14} />}
          </button>
        ) : null}
        <button
          type="button"
          className="dictation-row-act dictation-row-act-danger"
          aria-label="Delete"
          disabled={busy}
          onClick={onDelete}
        >
          <IconTrashCanSimple size={14} />
        </button>
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

function formatRunTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (isSameDate(date, now)) return `today ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (isSameDate(date, tomorrow)) return `tomorrow ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDate(date, yesterday)) return `yesterday ${time}`;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isSameDate(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function messageFromError(err: unknown) {
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "Routines are unavailable. Is June's agent running?";
}
