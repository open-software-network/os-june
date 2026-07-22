import { type HermesSessionInfo, type HermesSessionMessage } from "../../lib/tauri";
import { HermesGatewayClient } from "../../lib/hermes-gateway";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import {
  type PendingAttachmentPreparation,
  type PendingSteer,
  type QueuedAttachmentFollowUp,
} from "./composer/follow-up-queue";
import type * as React from "react";

export type createRuntimeReconciliationDependencies = {
  ensureHermesGateway: (fullMode?: boolean) => Promise<HermesGatewayClient>;
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
  workingReconcileMissesRef: React.MutableRefObject<Map<string, number>>;
  workingSessionIdsRef: React.MutableRefObject<Set<string>>;
};
