import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  dictationHelperCommand,
  importHermesBridgeFile,
  importHermesBridgeFileBytes,
  type ImportedHermesFile,
} from "../../lib/tauri";
import { messageFromError } from "../../lib/errors";
import { type ReportDialogAttachment } from "./ReportDialog";
import type { AgentAttachment } from "./agent-workspace-models";
import { type FileBytesImportOptions } from "./agent-session-continuity";
import { readFileBytes } from "./agent-workspace-support";
import type { createAttachmentImportActionsDependencies } from "./attachment-import-actions-types";

export function createAttachmentImportActions(
  dependencies: createAttachmentImportActionsDependencies,
) {
  const {
    agentAttachmentFromImportedFile,
    composerEditorRef,
    creditActionsDisabledReason,
    loadFilesystemSnapshot,
    setComposerAttachments,
    setError,
    setImportingFiles,
    setReportDialogAttachments,
  } = dependencies;

  function addReportDialogAttachments(nextAttachments: ReportDialogAttachment[]) {
    setReportDialogAttachments((current) => {
      const paths = new Set(current.map((attachment) => attachment.path));
      const uniqueAttachments = nextAttachments.filter((attachment) => {
        if (paths.has(attachment.path)) return false;
        paths.add(attachment.path);
        return true;
      });
      return [...current, ...uniqueAttachments];
    });
  }

  async function importAttachments<T>(
    items: T[],
    importItem: (item: T) => Promise<ImportedHermesFile>,
    options: { onImported?: (attachments: AgentAttachment[]) => void } = {},
  ) {
    if (!items.length) return true;
    setImportingFiles(true);
    try {
      // One at a time on purpose: a dropped file's bytes can be 50 MB, so
      // interleave read and upload to keep at most one buffer alive instead
      // of staging the whole batch (up to ~400 MB) in memory at once.
      const imported: ImportedHermesFile[] = [];
      for (const item of items) {
        imported.push(await importItem(item));
      }
      const nextAttachments = imported.map(agentAttachmentFromImportedFile);
      if (options.onImported) {
        options.onImported(nextAttachments);
      } else {
        setComposerAttachments((current) => [...current, ...nextAttachments]);
      }
      setError(null);
      void loadFilesystemSnapshot();
      return true;
    } catch (err) {
      setError(messageFromError(err));
      return false;
    } finally {
      setImportingFiles(false);
    }
  }

  // Native paths come from the file picker and Tauri drag-drop events.
  async function importDroppedFilePaths(
    paths: string[],
    options: { onImported?: (attachments: AgentAttachment[]) => void } = {},
  ) {
    const uniquePaths = Array.from(new Set(paths.map((path) => path.trim())))
      .filter(Boolean)
      .slice(0, 8);
    return importAttachments(uniquePaths, importHermesBridgeFile, options);
  }

  // DOM drops are how Finder files actually arrive: Tauri's drag-drop
  // interception is disabled (it has to be, so notes can use HTML5 drag into
  // folders) and WKWebView never exposes filesystem paths on dropped Files —
  // so read each blob and import its bytes.
  async function importDroppedFiles(
    files: File[],
    options: { onImported?: (attachments: AgentAttachment[]) => void; maxFiles?: number } = {},
  ) {
    const { maxFiles, ...importOptions } = options;
    return importFileBytes(
      files,
      {
        tooLargeMessage: "Dropped files must be 50 MB or smaller.",
        readErrorMessage: (file) =>
          // Reading fails for directories, which Finder happily lets you drop.
          `Could not read "${file.name}". Folders can't be attached.`,
        maxFiles,
      },
      importOptions,
    );
  }

  async function importPastedImageFiles(files: File[]) {
    await importFileBytes(files, {
      tooLargeMessage: "Pasted images must be 50 MB or smaller.",
      readErrorMessage: () => "Could not read the pasted image.",
    });
  }

  async function importFileBytes(
    files: File[],
    options: FileBytesImportOptions,
    importOptions: { onImported?: (attachments: AgentAttachment[]) => void } = {},
  ) {
    if (options.maxFiles !== undefined && files.length > options.maxFiles) {
      setError(`You can attach up to ${options.maxFiles} files at a time.`);
      return false;
    }
    const filesToImport = options.maxFiles === undefined ? files.slice(0, 8) : files;
    return importAttachments(
      filesToImport,
      async (file) => {
        if (file.size > 50 * 1024 * 1024) {
          throw new Error(options.tooLargeMessage);
        }
        const bytes = await readFileBytes(file).catch(() => {
          throw new Error(options.readErrorMessage(file));
        });
        return importHermesBridgeFileBytes(file.name, bytes);
      },
      importOptions,
    );
  }

  function removeAttachment(id: string) {
    setComposerAttachments((current) => current.filter((item) => item.id !== id));
  }

  // Focus the composer, then toggle the dictation helper's listening state —
  // the same command the hotkey path sends. The helper records, shows the HUD,
  // and pastes the transcription into the focused field (the composer).
  async function startDictation() {
    if (creditActionsDisabledReason) {
      setError(creditActionsDisabledReason);
      return;
    }
    composerEditorRef.current?.focus();
    try {
      await dictationHelperCommand({
        type: "toggle_listening",
        shortcut: "Dictation",
      });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  // The "+" picker routes through the same bridge import as drag-drop so the
  // agent always gets a real, readable path.
  async function pickAttachments(onImported?: (attachments: AgentAttachment[]) => void) {
    try {
      const selected = await openFileDialog({
        multiple: true,
        title: "Attach files",
      });
      if (!selected) return false;
      const paths = Array.isArray(selected) ? selected : [selected];
      return await importDroppedFilePaths(paths, { onImported });
    } catch (err) {
      setError(messageFromError(err));
      return false;
    }
  }

  return {
    addReportDialogAttachments,
    importAttachments,
    importDroppedFilePaths,
    importDroppedFiles,
    importPastedImageFiles,
    importFileBytes,
    removeAttachment,
    startDictation,
    pickAttachments,
  };
}
