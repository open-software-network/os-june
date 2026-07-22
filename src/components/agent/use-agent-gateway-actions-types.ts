import { HermesGatewayClient } from "../../lib/hermes-gateway";
import { ProjectContextSignatureStore } from "../../lib/agent-project-context";
import type { HermesBridgeStatus } from "../../lib/tauri";
import type * as React from "react";

export type UseAgentGatewayActionsDependencies = {
  bridge: HermesBridgeStatus;
  gatewayCloseHandlerRef: React.MutableRefObject<(_fullMode: boolean) => void>;
  gatewaysRef: React.MutableRefObject<Map<boolean, HermesGatewayClient>>;
  projectContextSignaturesBySessionId: ProjectContextSignatureStore;
  runtimeSessionIdsRef: React.MutableRefObject<Record<string, string>>;
  setRuntimeSessionIds: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  startBridge: (fullMode?: boolean) => Promise<HermesBridgeStatus>;
};
