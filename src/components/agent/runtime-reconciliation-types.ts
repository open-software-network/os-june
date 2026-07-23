import type { HermesSessionInfo, HermesSessionMessage } from "../../lib/tauri";
import type { AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import type {
  PendingAttachmentPreparation,
  PendingSteer,
  QueuedAttachmentFollowUp,
} from "./composer/follow-up-queue";
import type * as React from "react";

export type createRuntimeReconciliationDependencies = {
  hermesSessionItems: HermesSessionInfo[];
  pendingAttachmentPreparationsRef: React.MutableRefObject<
    Record<string, Map<number, PendingAttachmentPreparation>>
  >;
  pendingSteerBySessionIdRef: React.MutableRefObject<Record<string, PendingSteer[]>>;
  queuedAttachmentFollowUpsRef: React.MutableRefObject<Record<string, QueuedAttachmentFollowUp[]>>;
  recordSessionErrorActivity: (sessionId: string, message: string) => void;
  refreshHermesSession: (sessionId: string) => Promise<HermesSessionMessage[] | undefined>;
  runtimeSessionIdsRef: React.MutableRefObject<Record<string, string>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  workingReconcileStreaksRef: React.MutableRefObject<
    Map<string, { missing: number; unreachable: number }>
  >;
  workingSessionIdsRef: React.MutableRefObject<Set<string>>;
};
