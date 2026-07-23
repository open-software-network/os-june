import { type HermesSessionInfo, type HermesSessionMessage } from "../../lib/tauri";
import { type JuneHermesEvent } from "../../lib/hermes-control-plane";
import { type SessionModelSelectionMap } from "../../lib/hermes-session-model-selection";
import type * as React from "react";

export type createOptimisticSessionActionsDependencies = {
  commitSessionModelSelections: (next: SessionModelSelectionMap) => void;
  composerDraftKeyRef: React.MutableRefObject<string | null>;
  computerUseRunLeasesRef: React.MutableRefObject<Map<string, Set<string>>>;
  defaultGenerationModelIdRef: React.MutableRefObject<string>;
  generationCostQualityRef: React.MutableRefObject<number | undefined>;
  generationSelectionIntentRevisionRef: React.MutableRefObject<number>;
  hermesSessionMessagesRef: React.MutableRefObject<Record<string, HermesSessionMessage[]>>;
  heroExitViaThreadRef: React.MutableRefObject<boolean>;
  liveEventsRef: React.MutableRefObject<Record<string, JuneHermesEvent[]>>;
  newSessionModeRef: React.MutableRefObject<boolean>;
  pendingHermesMessagesRef: React.MutableRefObject<Record<string, HermesSessionMessage[]>>;
  recordSessionRunningActivity: (sessionId: string) => void;
  saveGenerationSelection: (write: () => Promise<unknown>) => Promise<void>;
  selectedHermesSessionIdRef: React.MutableRefObject<string | undefined>;
  sessionModelSelectionsRef: React.MutableRefObject<SessionModelSelectionMap>;
  setDefaultGenerationModelId: React.Dispatch<React.SetStateAction<string>>;
  setGenerationCostQuality: React.Dispatch<React.SetStateAction<number | undefined>>;
  setHermesSessionItems: React.Dispatch<React.SetStateAction<HermesSessionInfo[]>>;
  setHermesSessionMessages: React.Dispatch<
    React.SetStateAction<Record<string, HermesSessionMessage[]>>
  >;
  setLiveEvents: React.Dispatch<React.SetStateAction<Record<string, JuneHermesEvent[]>>>;
  setNewSessionMode: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingHermesMessages: React.Dispatch<
    React.SetStateAction<Record<string, HermesSessionMessage[]>>
  >;
  setSelectedHermesSessionId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSelectedTaskId: React.Dispatch<React.SetStateAction<string | undefined>>;
};
