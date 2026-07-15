import { Channel, invoke } from "@tauri-apps/api/core";

/** The two release streams. Wire form matches the Rust `ReleaseChannel`. */
export type ReleaseChannel = "stable" | "rc";

/**
 * Download progress streamed from the `install_update` command, shaped to match
 * the Rust `DownloadEvent` enum (`{ event, data }`). Defined here, at the IPC
 * boundary that owns the `Channel`, and consumed downward by update-decision.ts.
 */
export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** What `fetch_update` reports: enough to prompt, not the live update handle. */
type UpdateMeta = {
  version: string;
  body?: string;
};

/**
 * A frontend-facing update. The real `Update` stays in Rust (it can't be
 * serialized across IPC and only Rust can drive a channel-specific endpoint),
 * so `downloadAndInstall` is a thin bridge to the `install_update` command —
 * shaped to satisfy update-decision.ts's `UpdaterUpdate` so the surrounding
 * prompt/throttle/relaunch flow is unchanged.
 */
export type JuneUpdate = {
  version: string;
  body?: string;
  downloadAndInstall: (onEvent?: (event: DownloadEvent) => void) => Promise<void>;
};

export function getReleaseChannel(): Promise<ReleaseChannel> {
  return invoke<ReleaseChannel>("get_release_channel");
}

export function setReleaseChannel(channel: ReleaseChannel): Promise<void> {
  return invoke("set_release_channel", { channel });
}

async function fetchJuneUpdate(reconcile: boolean): Promise<JuneUpdate | null> {
  const meta = await invoke<UpdateMeta | null>("fetch_update", { reconcile });
  if (!meta) return null;
  return {
    version: meta.version,
    body: meta.body,
    downloadAndInstall: (onEvent) => installStagedUpdate(onEvent),
  };
}

/**
 * Checks for an update on the user's selected channel. The channel itself is
 * resolved Rust-side (from persisted state), so no channel argument is needed
 * and the check can never disagree with the saved setting. `reconcile` is false:
 * every routine check (launch/periodic/manual) is forward-only.
 */
export function checkJuneUpdate(): Promise<JuneUpdate | null> {
  return fetchJuneUpdate(false);
}

/**
 * The one-time escape from a prerelease build back onto stable, run only when the
 * user switches the channel to stable. Passing `reconcile=true` lets Rust offer an
 * *older* stable so leaving the rc channel drops you back onto the stable line
 * instead of stranding you on the rc build (Q4-Q6). Only meaningful on the stable
 * channel; Rust ignores it on rc so rc iteration ordering is never disturbed.
 */
export function reconcileToStable(): Promise<JuneUpdate | null> {
  return fetchJuneUpdate(true);
}

function installStagedUpdate(onEvent?: (event: DownloadEvent) => void): Promise<void> {
  const channel = new Channel<DownloadEvent>();
  if (onEvent) channel.onmessage = onEvent;
  return invoke("install_update", { onEvent: channel });
}

/**
 * Relaunches June to finish a staged update. Routes through the Rust
 * `relaunch_for_update` command instead of the plugin `relaunch()` so June's
 * child processes (the dictation helper, the Hermes runtime) are torn down
 * before the process restarts. A bare relaunch can skip that teardown and orphan
 * the helper, which then blocks the new instance from reading permissions
 * (JUN-338).
 */
export function relaunchJune() {
  return invoke("relaunch_for_update");
}
