import type { AgentAttachment } from "../agent-workspace-models";
import { type AgentWorkspaceErrorOptions } from "../agent-workspace-errors";
import type * as React from "react";

export type createComposerFileEventsDependencies = {
  importDroppedFiles: (
    files: File[],
    options?: { onImported?: (attachments: AgentAttachment[]) => void; maxFiles?: number },
  ) => Promise<boolean>;
  importPastedImageFiles: (files: File[]) => Promise<void>;
  reportDialogOpen: boolean;
  setDropActive: React.Dispatch<React.SetStateAction<boolean>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
};
