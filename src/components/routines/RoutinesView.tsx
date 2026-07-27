import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconCalendarRepeat } from "central-icons/IconCalendarRepeat";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
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
import { IconPause } from "central-icons/IconPause";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { messageFromError } from "../../lib/errors";
import {
  TRUST_MODE_META,
  eventTriggerScheduleDraft,
  isCreditableRun,
  routineToolsetsFor,
  routineTrustModeFromToolsets,
  triggerConfigFromDraft,
} from "../../lib/connectors";
import { useConnectorPolicy } from "../../lib/connector-policy";
import {
  isReplaceableRoutineRunTitle,
  listRoutineRunSessions,
  routineIdFromSession,
  type RoutineRunSession,
} from "../../lib/agent-routine-history";
import {
  createRoutine,
  listRoutines,
  pauseRoutine,
  removeRoutine,
  resumeRoutine,
  routineCreationPrompt,
  routineUnrestricted,
  triggerRoutine,
  UNRESTRICTED_ROUTINE_TOOLSETS,
  updateRoutine,
  type RoutineJob,
  type RoutineUpdates,
} from "../../lib/agent-routines";
import { compactScheduleLabel, humanizeSchedule } from "../../lib/routine-schedule";
import { useForcedEmptyStates } from "../../lib/empty-states-demo";
import {
  connectorTriggerSet,
  routineTrustRecordRun,
  routineTrustSet,
  type ConnectorPolicyCatalog,
} from "../../lib/tauri";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { HoverTip } from "../ui/HoverTip";
import { RoutineCreate, type RoutineCreateInput } from "./RoutineCreate";
import { RoutineDetail } from "./RoutineDetail";
import { formatRunTime, RoutineRunList } from "./RoutineRunList";
import { GrowingTextarea } from "./GrowingTextarea";
import { ROUTINE_TEMPLATES, type RoutineTemplate } from "./routine-templates";

const NO_ROUTINES: RoutineJob[] = [];
const NO_RUNS: RoutineRunSession[] = [];
const RUN_HISTORY_REFRESH_MS = 10000;

/**
 * Advances the earned-autonomy counter by reporting each finished run to the
 * local store, which credits it exactly once and only when the routine is in
 * approval mode with the run finishing after approval was enabled. Reporting
 * every finished run (rather than seeding a client-side baseline) is what lets
 * background runs that completed while this view was closed still count on the
 * next visit. Best-effort: a failure just retries on the next refresh.
 *
 * `reported` is a per-mount chatter guard so the 10s refresh does not re-report
 * the same run repeatedly; the local store is the durable, idempotent ledger, so a
 * fresh mount re-reporting a run is harmless.
 */
async function creditApprovalRuns(runs: RoutineRunSession[], reported: Set<string>): Promise<void> {
  for (const run of runs.filter(isCreditableRun)) {
    if (reported.has(run.id)) continue;
    const jobId = routineIdFromSession(run);
    const runEndedAt = run.ended_at ?? run.endedAt ?? null;
    if (!jobId || !runEndedAt) continue;
    reported.add(run.id);
    try {
      await routineTrustRecordRun({ jobId, runId: run.id, runEndedAt });
    } catch {
      // Let a transient failure retry on the next refresh.
      reported.delete(run.id);
    }
  }
}

type RoutinesViewProps = {
  /** The chat-first creation path: hands off a composed agent prompt and the
   * app opens a new June session with it, so the agent does the cron-job
   * setup (naming, scheduling) from a plain description. */
  onCreateRoutine: (prompt: string) => void;
  /** Opens a past scheduled run in the agent view. */
  onOpenRun: (session: RoutineRunSession) => void;
  creditActionsDisabledReason?: string;
};

type Page =
  | { kind: "list" }
  | { kind: "create"; template?: RoutineTemplate }
  | { kind: "detail"; jobId: string };

export function RoutinesView({
  onCreateRoutine,
  onOpenRun,
  creditActionsDisabledReason,
}: RoutinesViewProps) {
  const { policy } = useConnectorPolicy();
  const [allRoutines, setRoutines] = useState<RoutineJob[]>([]);
  const [loadingState, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorRetryable, setErrorRetryable] = useState(false);
  const [query, setQuery] = useState("");
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<RoutineJob | null>(null);
  const [page, setPage] = useState<Page>({ kind: "list" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailErrorRetryable, setDetailErrorRetryable] = useState(false);
  const [describeDraft, setDescribeDraft] = useState("");
  const [refreshSpins, setRefreshSpins] = useState(0);
  // Per-routine mode choice for the routine being described. Defaults to
  // sandboxed on every open: like the chat picker, Unrestricted is a
  // deliberate per-creation opt-in, never a sticky preference.
  const [describeUnrestricted, setDescribeUnrestricted] = useState(false);
  const [allRuns, setRuns] = useState<RoutineRunSession[]>([]);
  const [runsUnavailableState, setRunsUnavailable] = useState(false);
  const runLoadSequenceRef = useRef(0);
  // Run ids already reported for crediting this mount; the local store is the
  // durable idempotent ledger, this just avoids re-reporting on every refresh.
  const reportedRunsRef = useRef<Set<string>>(new Set());

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
      setErrorRetryable(false);
      return null;
    } catch (err) {
      const message = describeRoutineError(err);
      setError(message);
      setErrorRetryable(true);
      return message;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Run history comes from a different local store (the session store, not the
  // cron manager), so its failure must not take the routines list down with
  // it — it degrades to a quiet notice inside the section instead.
  const loadRuns = useCallback(async () => {
    const sequence = runLoadSequenceRef.current + 1;
    runLoadSequenceRef.current = sequence;
    try {
      const nextRuns = await listRoutineRunSessions({ includeActive: true });
      if (runLoadSequenceRef.current !== sequence) return;
      setRuns(nextRuns);
      setRunsUnavailable(false);
      void creditApprovalRuns(nextRuns, reportedRunsRef.current);
    } catch {
      if (runLoadSequenceRef.current !== sequence) return;
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

  useEffect(() => {
    if (forcedEmpty) return;
    const timer = window.setInterval(() => void loadRuns(), RUN_HISTORY_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [forcedEmpty, loadRuns]);

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
    (run: RoutineRunSession) => {
      const jobId = routineIdFromSession(run);
      const routine = jobId ? routinesById.get(jobId) : undefined;
      const sessionTitle = isReplaceableRoutineRunTitle(run.title) ? "" : run.title?.trim();
      return routine?.name || sessionTitle || "Routine run";
    },
    [routinesById],
  );

  const filteredRuns = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return runs;
    return runs.filter((run) =>
      `${runLabel(run)} ${run.title ?? ""} ${run.preview ?? ""}`.toLowerCase().includes(normalized),
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
      setDetailErrorRetryable(reloadError !== null);
    } catch (err) {
      const message = describeRoutineError(err);
      setError(message);
      setErrorRetryable(false);
      setDetailError(message);
      setDetailErrorRetryable(false);
    } finally {
      markBusy(routine.job_id, false);
    }
  }

  async function runNow(routine: RoutineJob) {
    if (creditActionsDisabledReason) return;
    markBusy(routine.job_id, true);
    try {
      await triggerRoutine(routine.job_id);
      setDetailError(null);
      setDetailErrorRetryable(false);
    } catch (err) {
      setDetailError(describeRoutineError(err));
      setDetailErrorRetryable(false);
      throw err;
    } finally {
      markBusy(routine.job_id, false);
    }
  }

  async function saveRoutine(jobId: string, updates: RoutineUpdates) {
    setSaving(true);
    try {
      await updateRoutine(jobId, updates);
      const reloadError = await loadRoutines();
      setDetailError(reloadError);
      setDetailErrorRetryable(reloadError !== null);
    } catch (err) {
      setDetailError(describeRoutineError(err));
      setDetailErrorRetryable(false);
      // Re-throw so RoutineDetail can roll back the trust/grant change it made
      // before this cron update. Swallowing the failure would leave the DB
      // trust and the job's enabled_toolsets inconsistent (a downgrade could
      // delete the grant while the job kept its old autonomous toolsets).
      throw err;
    } finally {
      setSaving(false);
    }
  }

  async function submitCreate(input: RoutineCreateInput) {
    setCreating(true);
    try {
      const eventTrigger = input.trigger.source !== "schedule" ? input.trigger : null;
      // A routine is connector-aware when anything about it touches Google:
      // a non-default trust mode, an event trigger, or a connector template's
      // scope requirements. Plain routines do not need a trust record, but
      // they still persist the native base catalog as an explicit grant.
      const connectorAware =
        input.trustMode !== "read_only" ||
        eventTrigger !== null ||
        (input.connectorScopes?.length ?? 0) > 0;
      let created: RoutineJob;
      if (connectorAware) {
        if (!policy) {
          setCreateError("Connector policy is still loading. Try again.");
          return;
        }
        created = await createRoutine({
          prompt: input.prompt,
          // Event routines still need a schedule record underneath. A
          // far-future one-time schedule hands firing to the trigger daemon.
          schedule: eventTrigger ? eventTriggerScheduleDraft().schedule : input.schedule,
          name: input.name,
          enabledToolsets: routineToolsetsFor(policy, input.trustMode, {
            unrestricted: input.unrestricted,
          }),
        });
      } else {
        created = await createRoutine({
          prompt: input.prompt,
          schedule: input.schedule,
          name: input.name,
          unrestricted: input.unrestricted,
          enabledToolsets: input.unrestricted
            ? UNRESTRICTED_ROUTINE_TOOLSETS
            : (policy?.routine.sandboxedBaseToolsets ?? []),
        });
      }
      if (connectorAware) {
        try {
          await routineTrustSet({
            jobId: created.job_id,
            trustMode: input.trustMode,
            autonomousTools: input.trustMode === "autonomous" ? input.autonomousTools : undefined,
          });
          if (eventTrigger && input.triggerAccountId) {
            // Subscribing is required setup, not best-effort. If it fails,
            // removeRoutine below deletes the June routine and all
            // connector rows so retrying cannot create a duplicate or leave a
            // dormant 2099 placeholder behind.
            await connectorTriggerSet({
              jobId: created.job_id,
              kind: eventTrigger.source,
              accountId: input.triggerAccountId,
              config: triggerConfigFromDraft(eventTrigger),
            });
          }
        } catch (setupError) {
          try {
            await removeRoutine(created.job_id);
          } catch (cleanupError) {
            throw new Error(
              `${describeRoutineError(setupError)} June also could not remove the partially created routine: ${describeRoutineError(cleanupError)}`,
            );
          }
          throw setupError;
        }
        // The first run fires right away (still under the chosen trust mode, so
        // any actions wait for approval), so an install shows value in the first
        // session instead of waiting for a future email or calendar event. This
        // one-off trigger leaves the routine active, so its event trigger can
        // keep firing later. The far-future schedule prevents timer dispatch.
        // Best-effort.
        await triggerRoutine(created.job_id).catch(() => {});
      }
      await loadRoutines();
      setCreateError(null);
      setDetailError(null);
      setDetailErrorRetryable(false);
      setPage({ kind: "detail", jobId: created.job_id });
    } catch (err) {
      setCreateError(describeRoutineError(err));
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
      setRoutines((prev) => prev.filter((entry) => entry.job_id !== routine.job_id));
      setError(null);
      setErrorRetryable(false);
      setPage((current) =>
        current.kind === "detail" && current.jobId === routine.job_id ? { kind: "list" } : current,
      );
    } catch (err) {
      const message = describeRoutineError(err);
      setError(message);
      setErrorRetryable(false);
      setDetailError(message);
      setDetailErrorRetryable(false);
    }
  }

  function submitDescribe() {
    // Describing a routine runs an agent session, so it is metered like every
    // other composer; the guard backs the disabled send button (Enter still
    // submits the form).
    if (creditActionsDisabledReason) return;
    const description = describeDraft.trim();
    if (!description) return;
    setDescribeDraft("");
    // routineCreationPrompt is async: for an unrestricted routine it strips the
    // native memory toolset from the list it embeds when Memory is off, so the
    // describe path cannot grant unscoped memory access behind the off switch.
    void routineCreationPrompt(description, {
      unrestricted: describeUnrestricted,
    }).then(onCreateRoutine);
  }

  function openCreate(template?: RoutineTemplate) {
    setCreateError(null);
    setPage({ kind: "create", template });
  }

  function openDetail(routine: RoutineJob) {
    setDetailError(null);
    setDetailErrorRetryable(false);
    setPage({ kind: "detail", jobId: routine.job_id });
  }

  function refreshNow() {
    setRefreshSpins((spins) => spins + 1);
    void refresh();
  }

  function retryListLoad() {
    setRefreshSpins((spins) => spins + 1);
    void loadRoutines();
  }

  function retryDetailLoad() {
    setRefreshSpins((spins) => spins + 1);
    void loadRoutines().then((reloadError) => {
      setDetailError(reloadError);
      setDetailErrorRetryable(reloadError !== null);
    });
  }

  const detailRoutine = page.kind === "detail" ? (routinesById.get(page.jobId) ?? null) : null;

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
      disabledReason={creditActionsDisabledReason}
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
    const routineRuns = runs.filter((run) => routineIdFromSession(run) === detailRoutine.job_id);
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
          runNowDisabledReason={creditActionsDisabledReason}
          onDelete={() => setPendingDelete(detailRoutine)}
          onOpenRun={onOpenRun}
          onRetryLoad={detailErrorRetryable ? retryDetailLoad : undefined}
          retrying={refreshing}
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
            {routines.length > 0 ? <span className="folders-count">{routines.length}</span> : null}
          </h1>
          <p className="folders-subtitle">Automations June runs for you on a schedule.</p>
        </div>
        <button type="button" className="primary-action primary-solid" onClick={() => openCreate()}>
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

      {error ? (
        <RoutineErrorBanner
          message={error}
          onRetry={errorRetryable ? retryListLoad : undefined}
          retrying={refreshing}
        />
      ) : null}

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
        <ul className="routines-list" aria-label="Routines">
          {filtered.map((routine) => (
            <RoutineRow
              key={routine.job_id}
              policy={policy}
              routine={routine}
              busy={busyIds.has(routine.job_id)}
              onOpen={() => openDetail(routine)}
              onRunNow={() =>
                void runNow(routine).catch((err) => {
                  setError(describeRoutineError(err));
                  setErrorRetryable(false);
                })
              }
              runNowDisabledReason={creditActionsDisabledReason}
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
              {runs.length > 0 ? <span className="folders-count">{runs.length}</span> : null}
            </h2>
          </header>
          {runsUnavailable ? (
            <p className="routines-runs-empty">Run history is unavailable right now.</p>
          ) : runs.length === 0 ? (
            <p className="routines-runs-empty">
              No runs yet. When a routine fires, its session appears here.
            </p>
          ) : (
            <div className="routines-runs-panel">
              <RoutineRunList runs={filteredRuns} label={runLabel} onOpen={onOpenRun} />
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

function TemplateGrid({ onPick }: { onPick: (template: RoutineTemplate) => void }) {
  return (
    <ul className="routines-template-grid">
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
            <p className="routines-template-description">{template.description}</p>
            {template.toolSummary ? (
              <p className="routines-template-tools">
                {template.toolSummary}
                {template.trustMode ? (
                  <span className="routines-template-trust">
                    {" "}
                    Trust: {TRUST_MODE_META[template.trustMode].label.toLowerCase()}.
                  </span>
                ) : null}
              </p>
            ) : null}
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
  policy,
  busy,
  onOpen,
  onRunNow,
  runNowDisabledReason,
  onDelete,
}: {
  routine: RoutineJob;
  policy: ConnectorPolicyCatalog | null;
  busy: boolean;
  onOpen: () => void;
  onRunNow: () => void;
  runNowDisabledReason?: string;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const paused = routine.state === "paused";
  const completed = routine.state === "completed";
  // Derived from the stored toolset override (no per-row round trip); only
  // the action-capable modes get a badge — ambient read access is every
  // routine's baseline and would read as noise.
  const trustMode = policy ? routineTrustModeFromToolsets(policy, routine.enabled_toolsets) : null;
  const trustBadge = trustMode === "approval" || trustMode === "autonomous" ? trustMode : null;
  const status = paused ? "Paused" : completed ? "Completed" : null;
  const activity =
    completed && routine.last_run_at ? `Last ran ${formatRunTime(routine.last_run_at)}` : null;

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
      data-has-actions="true"
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
            {trustBadge ? (
              <HoverTip
                tip={TRUST_MODE_META[trustBadge].description}
                className="routines-item-badge routines-item-badge-trust"
                tabIndex={0}
              >
                {TRUST_MODE_META[trustBadge].label}
              </HoverTip>
            ) : null}
            {routine.last_status === "error" ? (
              <span className="routines-item-badge routines-item-badge-error">Last run failed</span>
            ) : null}
          </span>
        </span>
        <span className="routines-item-meta">
          <span className="routine-meta-pill">
            <IconCalendarRepeat size={12} aria-hidden />
            {compactScheduleLabel(routine.schedule)}
          </span>
          {activity ? <span className="routine-meta-pill">{activity}</span> : null}
          {status ? (
            <span className="routine-meta-pill">
              {paused ? <IconPause size={12} aria-hidden /> : null}
              {status}
            </span>
          ) : null}
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
            <span className="sidebar-identity-menu routines-action-menu" role="menu">
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
                disabled={Boolean(runNowDisabledReason) || busy || routine.state !== "scheduled"}
                title={runNowDisabledReason}
                onClick={() => {
                  setMenuOpen(false);
                  onRunNow();
                }}
              >
                <IconPlay size={14} />
                Run now
              </button>
              <hr className="context-menu-separator" />
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

function describeRoutineError(err: unknown) {
  const message = messageFromError(err);
  if (/\bAPI returned 5\d\d\b/i.test(message)) {
    return "June ran into a problem with that request.";
  }
  return message || "Routines are unavailable. Try again.";
}

function RoutineErrorBanner({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="error-banner routines-error-banner" role="alert">
      <p>{message}</p>
      {onRetry ? (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onRetry}
          disabled={retrying}
          aria-busy={retrying || undefined}
        >
          <IconArrowRotateClockwise size={14} className="balance-refresh-icon" aria-hidden />
          Try again
        </button>
      ) : null}
    </div>
  );
}

const DEJUNE_MODE_OPTIONS = [
  {
    unrestricted: false,
    icon: <IconShieldCheck size={16} aria-hidden />,
    title: "Sandboxed",
    description: "The routine can read the web and memory but cannot touch your files.",
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
  disabledReason,
  onDraftChange,
  onUnrestrictedChange,
  onSubmit,
}: {
  draft: string;
  unrestricted: boolean;
  /** Set while funding blocks metered actions: send disables with this as
   * its tooltip (the draft itself stays editable, like the chat composers). */
  disabledReason?: string;
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
          <GrowingTextarea
            aria-label="Describe a routine"
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
                disabled={!draft.trim() || Boolean(disabledReason)}
                aria-label="Ask June to set it up"
                title={disabledReason}
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
            <p className="agent-sandbox-menu-title">What can this routine change?</p>
            {DEJUNE_MODE_OPTIONS.map((option) => (
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
                  <span className="agent-sandbox-option-title">{option.title}</span>
                  <span className="agent-sandbox-option-desc">{option.description}</span>
                </span>
                {unrestricted === option.unrestricted ? (
                  <IconCheckmark2Small
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
