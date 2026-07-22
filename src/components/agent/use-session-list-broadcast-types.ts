import type { HermesSessionInfo } from "../../lib/tauri";

export type UseSessionListBroadcastDependencies = {
  hermesSessionItems: HermesSessionInfo[];
  hermesSessionsHydrated: boolean;
  selectedHermesSessionId: string | undefined;
  waitingSessionIds: Set<string>;
  workingSessionIds: Set<string>;
};
