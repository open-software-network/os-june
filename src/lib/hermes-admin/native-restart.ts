/** June-owned Hermes runtime restart.
 *
 * Never replace this with Hermes' dashboard restart endpoint. June must remain
 * the parent process, and every respawn returns fresh connection credentials.
 */
import { startHermesBridge, stopHermesBridge, type HermesBridgeStatus } from "../tauri";
import type { HermesAdminMode } from "./target";

export async function restartHermesRuntime(mode: HermesAdminMode): Promise<HermesBridgeStatus> {
  await stopHermesBridge(mode);
  return startHermesBridge(undefined, mode === "unrestricted");
}
