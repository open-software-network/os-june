import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { ConnectorPolicyCatalog } from "./tauri";

export type ConnectorPolicyState = {
  policy: ConnectorPolicyCatalog | null;
  error: unknown;
};

function isConnectorPolicyCatalog(value: unknown): value is ConnectorPolicyCatalog {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ConnectorPolicyCatalog>;
  return (
    typeof candidate.version === "number" &&
    Array.isArray(candidate.providers) &&
    Array.isArray(candidate.scopeBundles) &&
    Array.isArray(candidate.scopeImplications) &&
    Array.isArray(candidate.servers) &&
    Array.isArray(candidate.serverOwnerPrefixes) &&
    Array.isArray(candidate.actionTools) &&
    Array.isArray(candidate.triggers) &&
    typeof candidate.earnedAutonomyMinApprovalRuns === "number" &&
    Boolean(candidate.routine) &&
    Array.isArray(candidate.routine?.sandboxedBaseToolsets) &&
    Array.isArray(candidate.routine?.readToolsets) &&
    Array.isArray(candidate.routine?.actionToolsets) &&
    Array.isArray(candidate.routine?.autonomousServerPrefixes)
  );
}

export async function loadConnectorPolicy(): Promise<ConnectorPolicyCatalog> {
  const value = await invoke<unknown>("connectors_policy");
  if (!isConnectorPolicyCatalog(value)) {
    throw new Error("Native connector policy returned an invalid catalog.");
  }
  return value;
}

/**
 * Loads the presentation-free connector policy from the native authority.
 * Callers stay fail-closed until the command resolves: no renderer fallback
 * reconstructs grant or eligibility rules.
 */
export function useConnectorPolicy(): ConnectorPolicyState {
  const [state, setState] = useState<ConnectorPolicyState>({
    policy: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    void loadConnectorPolicy()
      .then((policy) => {
        if (!cancelled) setState({ policy, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ policy: null, error });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
