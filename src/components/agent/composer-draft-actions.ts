import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { messageFromError } from "../../lib/errors";
import { noteReferenceToken } from "./composer/noteReference";
import { type ReportCategory } from "./composer/reportCategory";
import { type ReportDialogAttachment } from "./ReportDialog";
import type { AgentAttachment } from "./agent-workspace-models";
import {
  forgetComposerDraft,
  readComposerDraft,
  rememberComposerDraft,
  NEW_SESSION_DRAFT_KEY,
} from "./agent-session-continuity";
import type { createComposerDraftActionsDependencies } from "./composer-draft-actions-types";

export function createComposerDraftActions(dependencies: createComposerDraftActionsDependencies) {
  const {
    addReportDialogAttachments,
    attachmentsRef,
    categoryRef,
    composerDraftKeyRef,
    composerEditorRef,
    composerTiptapEditorRef,
    draftRef,
    importDroppedFiles,
    pendingSeedNoteRefRef,
    reportDialogGenerationRef,
    restoredComposerDraftKeyRef,
    setAttachMenuOpen,
    setAttachments,
    setCategory,
    setComposerHasContent,
    setDraft,
    setError,
    setImportingFiles,
    setReportDialogAttachments,
    setReportDialogCategory,
    setReportDialogDescription,
    setReportDialogOpen,
  } = dependencies;

  function clearComposerDraft(key = composerDraftKeyRef.current) {
    draftRef.current = "";
    categoryRef.current = null;
    attachmentsRef.current = [];
    setDraft("");
    setCategory(null);
    setComposerHasContent(false);
    setAttachments([]);
    forgetComposerDraft(key);
    composerEditorRef.current?.clear();
  }

  function restoreComposerDraft(key: string | null) {
    const editor = composerEditorRef.current;
    if (!editor) return;
    if (!editor.flushPendingChange({ persistWithoutRender: true })) return;
    restoredComposerDraftKeyRef.current = key;
    const snapshot = readComposerDraft(key);
    draftRef.current = snapshot?.text ?? "";
    categoryRef.current = snapshot?.category ?? null;
    attachmentsRef.current = snapshot?.attachments ?? [];
    setDraft(snapshot?.text ?? "");
    setCategory(snapshot?.category ?? null);
    setComposerHasContent(Boolean(snapshot?.text.trim()));
    setAttachments(snapshot?.attachments ?? []);
    editor.setContent(snapshot?.text ?? "", snapshot?.category ?? null, {
      focus: false,
      changeKey: key,
    });
  }

  function setComposerAttachments(
    nextValue: AgentAttachment[] | ((current: AgentAttachment[]) => AgentAttachment[]),
  ) {
    setAttachments((current) => {
      const next = typeof nextValue === "function" ? nextValue(current) : nextValue;
      attachmentsRef.current = next;
      rememberComposerDraft(
        composerDraftKeyRef.current,
        draftRef.current,
        categoryRef.current,
        next,
      );
      return next;
    });
  }

  function openReportDialog(categoryToOpen: ReportCategory) {
    setAttachMenuOpen(false);
    // Every entry-point open is a fresh report intent, so start clean —
    // even when reopening the same category. An abandoned draft (closed
    // without sending) must not survive close, because its stale
    // attachments (screenshots, logs) could ride into a later report
    // unnoticed. Bumping the generation also invalidates any in-flight
    // attachment import from the abandoned draft (see
    // reportDialogAppendForCurrentGeneration). Switching categories INSIDE
    // the open dialog still keeps the in-progress form — that lives in the
    // dialog's own category selector and is unaffected.
    reportDialogGenerationRef.current += 1;
    setReportDialogDescription("");
    setReportDialogAttachments([]);
    setReportDialogCategory(categoryToOpen);
    setReportDialogOpen(true);
  }

  /** Drops appends from imports that were still in flight when the report
   * was sent or the dialog was reopened: without this a slow import
   * repopulates the cleared attachment state and haunts the next report.
   * Both send and the next open bump the generation, so a mid-flight import
   * from an abandoned draft is discarded rather than resurfaced. */
  function reportDialogAppendForCurrentGeneration() {
    const generation = reportDialogGenerationRef.current;
    return (attachments: ReportDialogAttachment[]) => {
      if (generation === reportDialogGenerationRef.current) {
        addReportDialogAttachments(attachments);
      }
    };
  }

  async function pickReportDialogAttachments() {
    const append = reportDialogAppendForCurrentGeneration();
    setImportingFiles(true);
    try {
      const selected = await openFileDialog({
        multiple: true,
        title: "Attach files",
      });
      if (!selected) return false;

      const selectedPaths = Array.isArray(selected) ? selected : [selected];
      const uniquePaths = Array.from(new Set(selectedPaths.filter((path) => path.trim())));
      append(
        uniquePaths.map((path) => ({
          id: `${path}:${Date.now()}:${Math.random().toString(36)}`,
          name: path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path,
          path,
        })),
      );
      setError(null);
      return true;
    } catch (err) {
      setError(messageFromError(err));
      return false;
    } finally {
      setImportingFiles(false);
    }
  }

  function importReportDialogDroppedFiles(files: File[]) {
    return importDroppedFiles(files, {
      onImported: reportDialogAppendForCurrentGeneration(),
      maxFiles: 20,
    });
  }

  function removeReportDialogAttachment(id: string) {
    setReportDialogAttachments((current) => current.filter((item) => item.id !== id));
  }

  // Clears the draft once a dialog report is delivered. The dialog stays
  // open showing its own confirmation (no chat notice for dialog sends —
  // the pill is legacy chip-flow only); closing it is the user's move.
  function handleReportDialogSent() {
    reportDialogGenerationRef.current += 1;
    setReportDialogDescription("");
    setReportDialogAttachments([]);
    setError(null);
  }

  /** Applies any pending note reference to the composer once the editor is
   * available for cold-open note entry points. */
  function seedComposerNoteRef(options: { defer?: boolean } = {}) {
    if (!pendingSeedNoteRefRef.current) return;
    const editor = composerEditorRef.current;
    const tiptapEditor = composerTiptapEditorRef.current;
    // Not mounted yet (cold open) — leave it pending for onReady to apply.
    if (!editor || !tiptapEditor || tiptapEditor.isDestroyed) return;
    const applySeed = () => {
      const seed = pendingSeedNoteRefRef.current;
      const currentEditor = composerEditorRef.current;
      const currentTiptapEditor = composerTiptapEditorRef.current;
      if (!seed || !currentEditor || !currentTiptapEditor || currentTiptapEditor.isDestroyed) {
        return;
      }
      pendingSeedNoteRefRef.current = null;
      draftRef.current = `${noteReferenceToken(seed.noteRef)} ${seed.prompt}`;
      categoryRef.current = null;
      setDraft(draftRef.current);
      setCategory(null);
      rememberComposerDraft(NEW_SESSION_DRAFT_KEY, draftRef.current, null);
      restoredComposerDraftKeyRef.current = NEW_SESSION_DRAFT_KEY;
      currentEditor.setContent("", null);
      currentEditor.insertNoteReference(seed.noteRef);
      if (seed.prompt) {
        // String insertContent parses HTML; a node insert keeps the prompt literal.
        currentTiptapEditor
          .chain()
          .focus()
          .insertContent({ type: "text", text: seed.prompt })
          .run();
      } else {
        currentEditor.focus();
      }
    };
    if (options.defer) {
      window.setTimeout(applySeed, 0);
    } else {
      applySeed();
    }
  }

  return {
    clearComposerDraft,
    restoreComposerDraft,
    setComposerAttachments,
    openReportDialog,
    reportDialogAppendForCurrentGeneration,
    pickReportDialogAttachments,
    importReportDialogDroppedFiles,
    removeReportDialogAttachment,
    handleReportDialogSent,
    seedComposerNoteRef,
  };
}
