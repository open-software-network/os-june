import { type ClipboardEvent, type DragEvent } from "react";
import { type ImportedHermesFile } from "../../../lib/tauri";
import { attachmentStateFrom } from "../../../lib/hermes-image-attach";
import { clipboardImageFiles } from "../../../lib/clipboard-files";
import type { AgentAttachment } from "../agent-workspace-models";
import type { createComposerFileEventsDependencies } from "./composer-file-events-types";

export function createComposerFileEvents(dependencies: createComposerFileEventsDependencies) {
  const { importDroppedFiles, importPastedImageFiles, reportDialogOpen, setDropActive, setError } =
    dependencies;

  function handleComposerDragOver(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  }

  function handleComposerDrop(event: DragEvent<HTMLFormElement>) {
    // The report dialog's JSX lives inside this form, so its events React-
    // bubble here even though it renders in a portal; a report drop or paste
    // must never land in the chat composer.
    if (reportDialogOpen) return;
    event.preventDefault();
    setDropActive(false);
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) {
      setError("Drop files from Finder to attach them to the agent.");
      return;
    }
    void importDroppedFiles(files);
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLFormElement>) {
    if (reportDialogOpen) return;
    const files = clipboardImageFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    void importPastedImageFiles(files);
  }

  function agentAttachmentFromImportedFile(file: ImportedHermesFile): AgentAttachment {
    return {
      ...file,
      id: `${file.path}:${Date.now()}:${Math.random().toString(36)}`,
      // Seed the structured attach status (feature 19). Images become
      // `kind:"image"`, status `imported` — eligible for structured attach on
      // the next submit. No bytes are kept here.
      attach: attachmentStateFrom(file),
    };
  }

  return {
    handleComposerDragOver,
    handleComposerDrop,
    handleComposerPaste,
    agentAttachmentFromImportedFile,
  };
}
