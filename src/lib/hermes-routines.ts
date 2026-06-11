import { HermesGatewayClient } from "./hermes-gateway";
import { hermesBridgeStatus, startHermesBridge } from "./tauri";

/** A Hermes cron job as returned by the gateway's `cron.manage` method
 * (Hermes formats jobs via `_format_job`, so field names are snake_case). */
export type RoutineJob = {
  job_id: string;
  name: string;
  prompt_preview: string;
  schedule: string;
  repeat: string;
  deliver: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: "ok" | "error" | null;
  last_delivery_error?: string | null;
  enabled: boolean;
  state: "scheduled" | "paused" | "completed";
  paused_at?: string | null;
  paused_reason?: string | null;
  /** Per-job toolset override (`_format_job` includes it only when set).
   * Absent means the job runs under the sandboxed cron default the app
   * writes into config.yaml (CRON_SANDBOXED_TOOLSETS in hermes_bridge.rs);
   * the scheduler gives this field precedence over that gate, so its
   * presence with machine-touching toolsets is what makes a routine
   * unrestricted. */
  enabled_toolsets?: string[];
  /** Shell script attached to the job (`_format_job` includes it only when
   * set). The scheduler runs it as a plain subprocess of the unjailed
   * gateway on every tick — as the whole job for `no_agent` jobs, as the
   * wake-gate pre-run otherwise — so it sits entirely outside the toolset
   * gate. Any script-backed routine is unrestricted no matter what its
   * toolsets say. */
  script?: string | null;
  /** True for script-only jobs (no agent run at all). Implies `script`. */
  no_agent?: boolean;
};

/** The toolsets June must put on a routine the user opted into Unrestricted.
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

type CronManageResponse = {
  success?: boolean;
  error?: string;
  count?: number;
  jobs?: RoutineJob[];
  job?: RoutineJob;
};

// One gateway socket for the Routines view, lazily connected and reused across
// calls. AgentWorkspace keeps its own client; sharing would couple this view's
// lifecycle to the agent chat's reconnect logic for no benefit — the gateway
// accepts multiple sockets.
let client: HermesGatewayClient | undefined;

async function gatewayRequest<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const status = await hermesBridgeStatus();
  const bridge = status.running ? status : await startHermesBridge();
  const wsUrl = bridge.connection?.wsUrl;
  if (!wsUrl) throw new Error("Hermes did not return a gateway URL.");
  if (!client) client = new HermesGatewayClient();
  await client.connect(wsUrl);
  return client.request<T>(method, params);
}

// Hermes reports cron tool failures two ways: a JSON-RPC error (the request
// rejects) or an `{ success: false, error }` payload passed through from the
// cronjob tool. Normalize the latter into a throw so callers handle one shape.
async function manageRoutines(
  params: Record<string, unknown>,
): Promise<CronManageResponse> {
  const response = await gatewayRequest<CronManageResponse | undefined>(
    "cron.manage",
    params,
  );
  if (response?.success === false) {
    throw new Error(
      response.error || "Hermes could not complete the routine action.",
    );
  }
  return response ?? {};
}

export async function listRoutines(): Promise<RoutineJob[]> {
  const response = await manageRoutines({ action: "list" });
  return response.jobs ?? [];
}

/** The gateway's `cron.manage` reads the job reference from the wire param
 * `name` and resolves it as ID-or-name with exact ID match winning (Hermes
 * `resolve_job_ref`). Send the unique `job_id`, never the display name — two
 * routines can share a name, which Hermes rejects as ambiguous. */
export function pauseRoutine(jobId: string) {
  return manageRoutines({ action: "pause", name: jobId });
}

export function resumeRoutine(jobId: string) {
  return manageRoutines({ action: "resume", name: jobId });
}

export function removeRoutine(jobId: string) {
  return manageRoutines({ action: "remove", name: jobId });
}

/** Builds the agent prompt for "create a routine": June owns naming and
 * scheduling via its cronjob tool, so the user only describes the outcome.
 * The mode line carries the user's per-routine sandbox choice: sandboxed
 * routines must NOT set enabled_toolsets (the cron platform gate in
 * config.yaml then applies), unrestricted ones set the explicit override. */
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

/** Builds the agent prompt for "edit a routine". Editing also goes through
 * June: the gateway's cron.manage has no update action (the bundled Hermes
 * runtime is pinned upstream), while the agent's cronjob tool supports
 * partial updates — it can change just the schedule without ever reading or
 * re-sending the full prompt, which the list API truncates to a preview. */
export function routineEditPrompt(
  routine: Pick<
    RoutineJob,
    "job_id" | "name" | "schedule" | "enabled_toolsets" | "script" | "no_agent"
  >,
  changes: string,
) {
  const mode = routineUnrestricted(routine) ? "unrestricted" : "sandboxed";
  return [
    `Update my existing routine "${routine.name}" (cron job id ${routine.job_id}) using your cronjob tool's update action.`,
    `It currently runs: ${routine.schedule}. The routine is currently ${mode}. Here is what should change: ${changes.trim()}`,
    `If I asked to make it unrestricted, update the job with enabled_toolsets set to exactly: ${UNRESTRICTED_ROUTINE_TOOLSETS.join(", ")}. If I asked to make it sandboxed, clear enabled_toolsets and any script on the job so the restricted cron default applies again (cron scripts run as shell subprocesses outside the sandbox, so a sandboxed routine must not have one).`,
    "Only modify the fields I asked about and leave everything else on the job untouched. Confirm the updated job and when it runs next.",
  ].join("\n\n");
}
