import { type HermesSessionInfo, type HermesSessionMessage } from "../../lib/tauri";
import { HermesGatewayClient } from "../../lib/hermes-gateway";
import { type JuneHermesEvent } from "../../lib/hermes-control-plane";
import { type ComposerEditorHandle } from "./composer/ComposerEditor";
import { type ReportCategory } from "./composer/reportCategory";
import type { AgentAttachment } from "./agent-workspace-models";
import { type AgentPanel } from "./agent-workspace-config";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import type * as React from "react";

export type createBranchSessionActionDependencies = {
  BRANCH_TOAST_ID: "agent-branch";
  attachmentsRef: React.MutableRefObject<AgentAttachment[]>;
  branchingMessageIdRef: React.MutableRefObject<string | null>;
  categoryRef: React.MutableRefObject<ReportCategory | null>;
  composerDraftKeyRef: React.MutableRefObject<string | null>;
  composerEditorRef: React.MutableRefObject<ComposerEditorHandle | null>;
  draftRef: React.MutableRefObject<string>;
  ensureHermesGateway: (fullMode?: boolean) => Promise<HermesGatewayClient>;
  hermesSessionItems: HermesSessionInfo[];
  hermesSessionMessages: Record<string, HermesSessionMessage[]>;
  hermesSessionMessagesRef: React.MutableRefObject<Record<string, HermesSessionMessage[]>>;
  liveEventsRef: React.MutableRefObject<Record<string, JuneHermesEvent[]>>;
  loadHermesSessions: (options?: {
    suppressStartupRequestError?: boolean;
    suppressSessionGoneError?: boolean;
  }) => Promise<"skipped" | "loaded" | "transient-startup-error" | "failed">;
  newSessionModeRef: React.MutableRefObject<boolean>;
  pendingHermesMessagesRef: React.MutableRefObject<Record<string, HermesSessionMessage[]>>;
  profileOwnedSessionIdsRef: React.MutableRefObject<Set<string>>;
  restoredComposerDraftKeyRef: React.MutableRefObject<string | null | undefined>;
  runtimeSessionIdsRef: React.MutableRefObject<Record<string, string>>;
  selectedHermesSessionIdRef: React.MutableRefObject<string | undefined>;
  setActivePanel: React.Dispatch<React.SetStateAction<AgentPanel>>;
  setAttachments: React.Dispatch<React.SetStateAction<AgentAttachment[]>>;
  setBranchingMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  setCategory: React.Dispatch<React.SetStateAction<ReportCategory | null>>;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setHermesSessionMessages: React.Dispatch<
    React.SetStateAction<Record<string, HermesSessionMessage[]>>
  >;
  setLiveEvents: React.Dispatch<React.SetStateAction<Record<string, JuneHermesEvent[]>>>;
  setNewSessionMode: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingHermesMessages: React.Dispatch<
    React.SetStateAction<Record<string, HermesSessionMessage[]>>
  >;
  setRuntimeSessionIds: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setSelectedHermesSessionId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSelectedTaskId: React.Dispatch<React.SetStateAction<string | undefined>>;
};
