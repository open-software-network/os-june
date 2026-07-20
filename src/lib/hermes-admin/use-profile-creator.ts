import { useCallback, useEffect, useMemo, useState } from "react";
import { hermesBridgeStatus, type HermesBridgeStatus } from "../tauri";
import {
  createHermesAdminClient,
  type HermesAdminClient,
  type HermesCreateProfilePayload,
} from "./client";
import { createRustAdminFetch } from "./rust-transport";
import { adminTargetForMode, type HermesAdminMode } from "./target";

/** Creates profiles through the same mode-targeted admin client as the manager. */
export function useProfileCreator(mode: HermesAdminMode = "sandboxed") {
  const [bridge, setBridge] = useState<HermesBridgeStatus>();

  useEffect(() => {
    let cancelled = false;
    hermesBridgeStatus()
      .then((status) => {
        if (!cancelled) setBridge(status);
      })
      .catch(() => {
        if (!cancelled) setBridge(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const client = useMemo<HermesAdminClient | null>(() => {
    const target = bridge ? adminTargetForMode(bridge, mode) : undefined;
    if (!target) return null;
    return createHermesAdminClient(target, { fetch: createRustAdminFetch(target.mode) });
  }, [bridge, mode]);

  return useCallback(
    async (payload: HermesCreateProfilePayload): Promise<void> => {
      if (client) {
        await client.profiles.create(payload);
        return;
      }
      const latestBridge = await hermesBridgeStatus();
      const target = adminTargetForMode(latestBridge, mode);
      if (!target) throw new Error("Hermes is not running.");
      const latestClient = createHermesAdminClient(target, {
        fetch: createRustAdminFetch(target.mode),
      });
      await latestClient.profiles.create(payload);
    },
    [client, mode],
  );
}
