import { useEffect, useState } from "react";
import { useActiveHermesProfile } from "../../lib/active-hermes-profile";
import { adminTargetForMode, type HermesAdminMode } from "../../lib/hermes-admin";
import { hermesBridgeStatus } from "../../lib/tauri";

export function useConfirmedSettingsProfile(mode: HermesAdminMode): {
  name: string;
  pending: boolean;
} {
  const active = useActiveHermesProfile();
  const [bridgeTargetable, setBridgeTargetable] = useState<boolean>();

  useEffect(() => {
    let cancelled = false;
    setBridgeTargetable(undefined);
    hermesBridgeStatus()
      .then((status) => {
        if (!cancelled) setBridgeTargetable(Boolean(adminTargetForMode(status, mode)));
      })
      .catch(() => {
        if (!cancelled) setBridgeTargetable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  return {
    name: active.name,
    pending: !active.confirmed && bridgeTargetable !== false,
  };
}
