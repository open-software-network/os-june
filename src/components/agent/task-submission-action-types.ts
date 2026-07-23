import { type ComposerEditorHandle } from "./composer/ComposerEditor";
import { type NoteReferenceInput } from "./composer/noteReference";
import { type ReportCategory } from "./composer/reportCategory";
import type { SubmitHermesSession } from "./session-submission-types";
import { type AgentPanel } from "./agent-workspace-config";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import type * as React from "react";

export type createTaskSubmissionActionDependencies = {
  clearComposerDraft: (key?: string) => void;
  composerDraftKeyRef: React.MutableRefObject<string | null>;
  composerEditorRef: React.MutableRefObject<ComposerEditorHandle | null>;
  lastAutoSubmittedRef: React.MutableRefObject<{ prompt: string; at: number } | undefined>;
  newSessionModeRef: React.MutableRefObject<boolean>;
  openReportDialog: (categoryToOpen: ReportCategory) => void;
  pendingSeedNoteRefRef: React.MutableRefObject<{
    noteRef: NoteReferenceInput;
    prompt: string;
  } | null>;
  restoreComposerDraft: (key: string | null) => void;
  seedComposerNoteRef: (options?: { defer?: boolean }) => void;
  selectedHermesSessionIdRef: React.MutableRefObject<string | undefined>;
  setActivePanel: React.Dispatch<React.SetStateAction<AgentPanel>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setNewSessionMode: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedHermesSessionId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSelectedTaskId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSubmitting: React.Dispatch<React.SetStateAction<boolean>>;
  setSubmittingHermesSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  submitHermesSession: SubmitHermesSession;
};
