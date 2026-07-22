import { type ImportedHermesFile } from "../../lib/tauri";
import { type ComposerEditorHandle } from "./composer/ComposerEditor";
import { type ReportDialogAttachment } from "./ReportDialog";
import type { AgentAttachment } from "./agent-workspace-models";
import type { AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import type * as React from "react";

export type createAttachmentImportActionsDependencies = {
  agentAttachmentFromImportedFile: (file: ImportedHermesFile) => AgentAttachment;
  composerEditorRef: React.MutableRefObject<ComposerEditorHandle | null>;
  creditActionsDisabledReason: string | undefined;
  loadFilesystemSnapshot: () => Promise<void>;
  setComposerAttachments: (
    nextValue: AgentAttachment[] | ((current: AgentAttachment[]) => AgentAttachment[]),
  ) => void;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setImportingFiles: React.Dispatch<React.SetStateAction<boolean>>;
  setReportDialogAttachments: React.Dispatch<React.SetStateAction<ReportDialogAttachment[]>>;
};
