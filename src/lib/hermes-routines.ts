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
};

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
 * scheduling via its cronjob tool, so the user only describes the outcome. */
export function routineCreationPrompt(description: string) {
  return [
    "Set up a new routine (a scheduled cron job) for me using your cronjob tool.",
    `Here is what it should do: ${description.trim()}`,
    "Pick a short descriptive name and an appropriate schedule (ask me if the timing is unclear), create the job, then confirm what you created and when it will first run.",
  ].join("\n\n");
}
