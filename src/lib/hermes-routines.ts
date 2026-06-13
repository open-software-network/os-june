import {
  createHermesBridgeCronJob,
  deleteHermesBridgeCronJob,
  hermesBridgeCronJobAction,
  hermesBridgeCronJobs,
  hermesBridgeStatus,
  startHermesBridge,
  updateHermesBridgeCronJob,
  type HermesCronJobRecord,
} from "./tauri";

/** A Hermes cron job as the app works with it: the raw dashboard-API record
 * flattened to what the Routines surfaces read. Unlike the gateway's
 * formatted listing this carries the full `prompt`, so the editor can show
 * and update instructions without an agent round trip. */
export type RoutineJob = {
  job_id: string;
  name: string;
  prompt: string;
  prompt_preview: string;
  schedule: string;
  repeat: string;
  deliver: string;
  created_at: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: "ok" | "error" | null;
  last_error?: string | null;
  last_delivery_error?: string | null;
  enabled: boolean;
  state: "scheduled" | "paused" | "completed";
  paused_reason?: string | null;
  /** Per-job toolset override. Absent means the job runs under the sandboxed
   * cron default the app writes into config.yaml (CRON_SANDBOXED_TOOLSETS in
   * hermes_bridge.rs); the scheduler gives this field precedence over that
   * gate, so its presence with machine-touching toolsets is what makes a
   * routine unrestricted. */
  enabled_toolsets?: string[];
  /** Shell script attached to the job. The scheduler runs it as a plain
   * subprocess of the unjailed gateway on every tick — as the whole job for
   * `no_agent` jobs, as the wake-gate pre-run otherwise — so it sits entirely
   * outside the toolset gate. Any script-backed routine is unrestricted no
   * matter what its toolsets say. */
  script?: string | null;
  /** True for script-only jobs (no agent run at all). Implies `script`. */
  no_agent?: boolean;
};

/** The toolsets June puts on a routine the user opted into Unrestricted.
 * Hermes's full default set minus the toolsets its scheduler always strips
 * from cron agents (cronjob, messaging, clarify) and the default-off niche
 * sets. Keep in sync with CRON_SANDBOXED_TOOLSETS in hermes_bridge.rs, which
 * is the sandboxed counterpart this list overrides. */
export const UNRESTRICTED_ROUTINE_TOOLSETS = [
  "terminal",
  "file",
  "code_execution",
  "web",
  "browser",
  "vision",
  "image_gen",
  "tts",
  "skills",
  "todo",
  "memory",
  "context_engine",
  "session_search",
  "delegation",
  "computer_use",
];

/** Toolsets that let a routine change the machine or act on it: their
 * presence in a job's override is what "Unrestricted" means for routines.
 * The sandboxed cron default contains none of them. */
const MACHINE_TOOLSETS = new Set([
  "terminal",
  "file",
  "code_execution",
  "browser",
  "computer_use",
  "delegation",
  "skills",
]);

/** Whether a routine can touch the machine when it fires. Derived from the
 * stored job rather than any UI state, so the badge reflects what the
 * scheduler will actually enforce on the next run. Two paths count:
 * machine-touching toolsets in the per-job override, and an attached cron
 * script — scripts run as plain subprocesses of the unjailed gateway,
 * outside the toolset gate entirely. */
export function routineUnrestricted(
  routine: Pick<RoutineJob, "enabled_toolsets" | "script" | "no_agent">,
): boolean {
  if (routine.script || routine.no_agent) return true;
  return (routine.enabled_toolsets ?? []).some((toolset) =>
    MACHINE_TOOLSETS.has(toolset),
  );
}

/** The dashboard API lives on the bridge process, so make sure one is up
 * before calling — same lazy-start the gateway client used to do. */
async function withBridge<T>(run: () => Promise<T>): Promise<T> {
  const status = await hermesBridgeStatus();
  if (!status.running) await startHermesBridge();
  return run();
}

function routineFromRecord(record: HermesCronJobRecord): RoutineJob {
  const prompt = record.prompt ?? "";
  const times = record.repeat?.times;
  const state =
    record.state === "paused" || record.state === "completed"
      ? record.state
      : (record.enabled ?? true)
        ? "scheduled"
        : "paused";
  return {
    job_id: record.id,
    name: record.name || prompt.slice(0, 50) || record.id,
    prompt,
    prompt_preview: prompt.length > 100 ? `${prompt.slice(0, 100)}...` : prompt,
    schedule: record.schedule_display || "?",
    repeat: times ? `${times}x` : "forever",
    deliver: record.deliver || "local",
    created_at: record.created_at ?? null,
    next_run_at: record.next_run_at ?? null,
    last_run_at: record.last_run_at ?? null,
    last_status: record.last_status ?? null,
    last_error: record.last_error ?? null,
    last_delivery_error: record.last_delivery_error ?? null,
    enabled: record.enabled ?? true,
    state,
    paused_reason: record.paused_reason ?? null,
    enabled_toolsets: record.enabled_toolsets ?? undefined,
    script: record.script ?? null,
    no_agent: record.no_agent ?? false,
  };
}

export async function listRoutines(): Promise<RoutineJob[]> {
  const records = await withBridge(() => hermesBridgeCronJobs());
  return records.map(routineFromRecord);
}

/** Creates a routine directly through the dashboard API. The create endpoint
 * only takes prompt/schedule/name, so the unrestricted opt-in lands as an
 * immediate follow-up update; a failure there surfaces rather than silently
 * leaving the job sandboxed. */
export async function createRoutine(input: {
  prompt: string;
  schedule: string;
  name?: string;
  unrestricted?: boolean;
}): Promise<RoutineJob> {
  return withBridge(async () => {
    const created = await createHermesBridgeCronJob({
      prompt: input.prompt,
      schedule: input.schedule,
      name: input.name,
    });
    if (!input.unrestricted) return routineFromRecord(created);
    const widened = await updateHermesBridgeCronJob(created.id, {
      enabled_toolsets: UNRESTRICTED_ROUTINE_TOOLSETS,
    });
    return routineFromRecord(widened);
  });
}

export type RoutineUpdates = {
  name?: string;
  schedule?: string;
  prompt?: string;
  /** True widens the job to UNRESTRICTED_ROUTINE_TOOLSETS. False restores
   * the sandboxed cron default — clearing the toolset override AND any
   * attached script, since scripts run outside the toolset gate. */
  unrestricted?: boolean;
};

export async function updateRoutine(
  jobId: string,
  updates: RoutineUpdates,
): Promise<RoutineJob> {
  const payload: Record<string, unknown> = {};
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.schedule !== undefined) payload.schedule = updates.schedule;
  if (updates.prompt !== undefined) payload.prompt = updates.prompt;
  if (updates.unrestricted === true) {
    payload.enabled_toolsets = UNRESTRICTED_ROUTINE_TOOLSETS;
  } else if (updates.unrestricted === false) {
    payload.enabled_toolsets = null;
    payload.script = null;
    payload.no_agent = false;
  }
  const record = await withBridge(() =>
    updateHermesBridgeCronJob(jobId, payload),
  );
  return routineFromRecord(record);
}

export function pauseRoutine(jobId: string) {
  return withBridge(() => hermesBridgeCronJobAction(jobId, "pause"));
}

export function resumeRoutine(jobId: string) {
  return withBridge(() => hermesBridgeCronJobAction(jobId, "resume"));
}

/** Queues an immediate run. The launchd-managed gateway picks the job up on
 * its next scheduler tick, so the run starts within about a minute — and
 * only if the gateway is running. */
export function triggerRoutine(jobId: string) {
  return withBridge(() => hermesBridgeCronJobAction(jobId, "trigger"));
}

export function removeRoutine(jobId: string) {
  return withBridge(() => deleteHermesBridgeCronJob(jobId));
}

/** Builds the agent prompt for the "describe it" creation path: June owns
 * naming and scheduling via its cronjob tool, so the user only describes the
 * outcome. The mode line carries the user's per-routine sandbox choice:
 * sandboxed routines must NOT set enabled_toolsets (the cron platform gate
 * in config.yaml then applies), unrestricted ones set the explicit
 * override. */
export function routineCreationPrompt(
  description: string,
  options?: { unrestricted?: boolean },
) {
  const mode = options?.unrestricted
    ? `I chose to run this routine unrestricted. Create the job with enabled_toolsets set to exactly: ${UNRESTRICTED_ROUTINE_TOOLSETS.join(", ")}.`
    : "I chose the sandboxed default for this routine. Do not set enabled_toolsets on the job: it then runs with the restricted cron toolset (web reading, vision, todo, memory, session search) and cannot use the terminal, change files, execute code, or drive a browser. Do not attach a script to the job either: cron scripts run as plain shell subprocesses outside that sandbox. If the task clearly needs any of this, stop and tell me it requires an unrestricted routine instead of creating it.";
  return [
    "Set up a new routine (a scheduled cron job) for me using your cronjob tool.",
    `Here is what it should do: ${description.trim()}`,
    mode,
    "Pick a short descriptive name and an appropriate schedule (ask me if the timing is unclear), create the job, then confirm what you created and when it will first run.",
  ].join("\n\n");
}
