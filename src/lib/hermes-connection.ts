import type { HermesBridgeConnection, HermesBridgeStatus } from "./tauri";

/** The live connection serving the given write-access mode, if any. The
 * bridge runs up to one runtime process per mode side by side; mode-aware
 * callers pick their process here instead of assuming a single runtime. */
export function hermesConnectionForMode(
  status: HermesBridgeStatus | undefined,
  fullMode: boolean,
): HermesBridgeConnection | undefined {
  if (!status?.running) return undefined;
  const fromList = status.connections?.find(
    (connection) => Boolean(connection.fullMode) === fullMode,
  );
  if (fromList) return fromList;
  // Older payload shape without `connections`.
  return status.connection && Boolean(status.connection.fullMode) === fullMode
    ? status.connection
    : undefined;
}
