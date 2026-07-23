import type { Editor as TiptapEditor } from "@tiptap/react";
import { type ComposerEditorHandle } from "./composer/ComposerEditor";
import { type NoteReferenceInput } from "./composer/noteReference";
import { type ReportCategory } from "./composer/reportCategory";
import { type ReportDialogAttachment } from "./ReportDialog";
import type { AgentAttachment } from "./agent-workspace-models";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import type * as React from "react";

export type createComposerDraftActionsDependencies = {
  addReportDialogAttachments: (nextAttachments: ReportDialogAttachment[]) => void;
  attachmentsRef: React.MutableRefObject<AgentAttachment[]>;
  categoryRef: React.MutableRefObject<ReportCategory | null>;
  composerDraftKeyRef: React.MutableRefObject<string | null>;
  composerEditorRef: React.MutableRefObject<ComposerEditorHandle | null>;
  composerTiptapEditorRef: React.MutableRefObject<TiptapEditor | null>;
  draftRef: React.MutableRefObject<string>;
  importDroppedFiles: (
    files: File[],
    options?: { onImported?: (attachments: AgentAttachment[]) => void; maxFiles?: number },
  ) => Promise<boolean>;
  pendingSeedNoteRefRef: React.MutableRefObject<{
    noteRef: NoteReferenceInput;
    prompt: string;
  } | null>;
  reportDialogGenerationRef: React.MutableRefObject<number>;
  restoredComposerDraftKeyRef: React.MutableRefObject<string | null | undefined>;
  setAttachMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setAttachments: React.Dispatch<React.SetStateAction<AgentAttachment[]>>;
  setCategory: React.Dispatch<React.SetStateAction<ReportCategory | null>>;
  setComposerHasContent: React.Dispatch<React.SetStateAction<boolean>>;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setImportingFiles: React.Dispatch<React.SetStateAction<boolean>>;
  setReportDialogAttachments: React.Dispatch<React.SetStateAction<ReportDialogAttachment[]>>;
  setReportDialogCategory: React.Dispatch<React.SetStateAction<ReportCategory>>;
  setReportDialogDescription: React.Dispatch<React.SetStateAction<string>>;
  setReportDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
};
