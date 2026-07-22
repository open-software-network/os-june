import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconPaperclip1 } from "central-icons/IconPaperclip1";
import { type ClipboardEvent, type DragEvent, useId, useMemo, useRef, useState } from "react";

import { clipboardImageFiles } from "../../lib/clipboard-files";
import { messageFromError } from "../../lib/errors";
import { appendIssueReportSessionContext } from "../../lib/issue-report-session-context";
import { recordPositiveFeedbackSent } from "../../lib/referral-nudge";
import { submitIssueReport } from "../../lib/tauri";
import { DotSpinner } from "../DotSpinner";
import { Dialog, DialogField } from "../ui/Dialog";
import { SegmentedControl } from "../ui/SegmentedControl";
import { CategoryIcon } from "./composer/CategoryIcon";
import {
  ISSUE_REPORT_ATTACHMENTS_ONLY_DESCRIPTION,
  REPORT_CATEGORIES,
  type ReportCategory,
  reportCategoryDef,
} from "./composer/reportCategory";
import { FileTypeIcon } from "./FileTypeIcon";

export type ReportDialogAttachment = {
  id: string;
  name: string;
  path: string;
  previewDataUrl?: string | null;
};

const REPORT_DIALOG_DOM_DROP_MAX_BYTES = 50 * 1024 * 1024;
const REPORT_DIALOG_MAX_ATTACHMENTS = 20;
const REPORT_SESSION_CONTEXT_LOAD_TIMEOUT_MS = 1_000;

async function loadSessionContextBestEffort(
  loader: (() => Promise<string | undefined>) | undefined,
): Promise<string | undefined> {
  if (!loader) return undefined;
  let load: Promise<string | undefined>;
  try {
    load = Promise.resolve(loader()).catch(() => undefined);
  } catch {
    return undefined;
  }
  let timeoutId: number | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timeoutId = window.setTimeout(resolve, REPORT_SESSION_CONTEXT_LOAD_TIMEOUT_MS);
  });
  try {
    return await Promise.race([load, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

type ReportDialogProps = {
  category: ReportCategory;
  description: string;
  attachments: ReportDialogAttachment[];
  importingFiles: boolean;
  onCategoryChange: (category: ReportCategory) => void;
  onDescriptionChange: (description: string) => void;
  onAddFiles: () => unknown;
  onDropFiles: (files: File[]) => unknown;
  onRemoveAttachment: (id: string) => void;
  sessionContext?: { id: string; title?: string };
  loadSessionContext?: () => Promise<string | undefined>;
  onRemoveSessionContext?: () => void;
  onClose: () => void;
  onSent: () => void;
};

export function ReportDialog({
  category,
  description,
  attachments,
  importingFiles,
  onCategoryChange,
  onDescriptionChange,
  onAddFiles,
  onDropFiles,
  onRemoveAttachment,
  sessionContext,
  loadSessionContext,
  onRemoveSessionContext,
  onClose,
  onSent,
}: ReportDialogProps) {
  const [dropActive, setDropActive] = useState(false);
  // Enter/leave fire for every child edge crossed; only depth zero means the
  // pointer truly left the drop zone (otherwise the overlay flickers).
  const dragDepthRef = useRef(0);
  // State updates are not visible until React renders again. Reserve the DOM
  // import slot synchronously so two drops in the same tick cannot both start.
  const domImportPendingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  // Dropped-file imports resolve in the parent, and `importingFiles` only
  // reflects them a render later — count in-flight drops here too so a fast
  // "drop then send" cannot submit the report without the dropped file.
  const [dropsPending, setDropsPending] = useState(0);
  const [sent, setSent] = useState(false);
  // Files that could not be attached to the report in Open Software are shown
  // with the confirmation so a skipped file is never a silent drop.
  const [skippedAttachmentNames, setSkippedAttachmentNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const descriptionId = useId();
  const trimmedDescription = description.trim();
  const excessAttachmentCount = Math.max(0, attachments.length - REPORT_DIALOG_MAX_ATTACHMENTS);
  const canSubmit =
    Boolean(trimmedDescription || attachments.length) && excessAttachmentCount === 0;
  const busy = submitting || importingFiles || dropsPending > 0;
  const categoryOptions = useMemo(
    () =>
      REPORT_CATEGORIES.map((item) => ({
        value: item.key,
        ariaLabel: item.label,
        label: (
          <>
            <CategoryIcon category={item.key} size={14} />
            <span className="report-dialog-category-label">{item.label}</span>
          </>
        ),
      })),
    [],
  );

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    // The dialog is portaled but its JSX lives inside the composer form, so
    // React bubbles these events to the composer's own drop/paste importers
    // behind the modal — stop them here or attachments leak into the chat.
    event.stopPropagation();
    event.dataTransfer.dropEffect =
      sent || submitting || importingFiles || domImportPendingRef.current ? "none" : "copy";
  }

  function handleDragEnter() {
    dragDepthRef.current += 1;
    setDropActive(true);
  }

  function handleDragLeave() {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropActive(false);
  }

  function queueFileImport(files: File[]) {
    if (sent || submitting || importingFiles || domImportPendingRef.current) {
      setError(
        "Please wait for the current import or report submission to finish, then try again.",
      );
      return;
    }
    if (attachments.length + files.length > REPORT_DIALOG_MAX_ATTACHMENTS) {
      setError(
        "Reports can include up to 20 attachments. Remove attachments before adding these files.",
      );
      return;
    }
    if (files.some((file) => file.size > REPORT_DIALOG_DOM_DROP_MAX_BYTES)) {
      setError(
        "Files added by drop or paste must be 50 MB or smaller. Use Add files for videos up to 300 MB.",
      );
      return;
    }
    domImportPendingRef.current = true;
    setError(null);
    setDropsPending((count) => count + 1);
    let importResult: unknown;
    try {
      importResult = onDropFiles(files);
    } catch (err) {
      domImportPendingRef.current = false;
      setDropsPending((count) => count - 1);
      setError(`The files could not be added. ${messageFromError(err)}`);
      return;
    }
    void Promise.resolve(importResult)
      .catch((err) => setError(`The files could not be added. ${messageFromError(err)}`))
      .finally(() => {
        domImportPendingRef.current = false;
        setDropsPending((count) => count - 1);
      });
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDropActive(false);
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) {
      setError("Drop files from Finder to attach them to the report.");
      return;
    }
    queueFileImport(files);
  }

  // Pasted screenshots become attachments, same as the composer. Only image
  // files are interceptable (Finder file copies never reach clipboardData);
  // a plain text paste falls through to the textarea untouched.
  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    const files = clipboardImageFiles(event.clipboardData);
    if (!files.length) return;
    // Mixed payload (e.g. a copied web-page selection carrying both text and
    // an image): import the image but let the browser paste the text into the
    // textarea — preventing default would silently drop the text the user
    // meant to keep. With no meaningful text we preventDefault, which also
    // stops screenshot tools' stray metadata from landing in the field.
    const hasText = Boolean(event.clipboardData?.getData("text/plain")?.trim());
    if (!hasText) event.preventDefault();
    queueFileImport(files);
  }

  async function handleSubmit() {
    if (!canSubmit || busy) return;
    setSubmitting(true);
    setError(null);
    try {
      const relatedSessionContext = await loadSessionContextBestEffort(loadSessionContext);
      const response = await submitIssueReport({
        category,
        description: appendIssueReportSessionContext(
          trimmedDescription || ISSUE_REPORT_ATTACHMENTS_ONLY_DESCRIPTION,
          relatedSessionContext,
        ),
        attachmentNames: attachments.map((attachment) => attachment.name),
        attachmentPaths: attachments.map((attachment) => attachment.path),
        ...(sessionContext ? { sessionId: sessionContext.id } : {}),
      });
      setSubmitting(false);
      setSkippedAttachmentNames(response?.skippedAttachmentNames ?? []);
      setSent(true);
      // T4 of the referral delight nudge: positive feedback only, never bug
      // reports or feature requests.
      if (category === "feedback") recordPositiveFeedbackSent();
      onSent();
    } catch (err) {
      setSubmitting(false);
      setError(`The issue report could not be sent. ${messageFromError(err)}`);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Issue report"
      className="report-dialog"
      initialFocusSelector=".dialog-textarea"
      footer={
        sent ? (
          <button type="button" className="primary-action primary-solid" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-ghost report-dialog-add-files"
              disabled={busy}
              onClick={() => {
                setError(null);
                void onAddFiles();
              }}
            >
              <IconPaperclip1 size={16} aria-hidden />
              {importingFiles ? "Adding files" : "Add files"}
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={!canSubmit || busy}
              aria-busy={submitting || undefined}
              onClick={() => void handleSubmit()}
            >
              {submitting ? <DotSpinner className="report-dialog-submit-spinner" /> : null}
              {submitting ? "Sending" : "Send report"}
            </button>
          </>
        )
      }
    >
      {sent ? (
        <>
          <p className="report-dialog-sent" role="status">
            Your report was sent to the June team. Thank you for helping improve June.
          </p>
          {skippedAttachmentNames.length ? (
            <p className="report-dialog-error" role="alert">
              These files could not be attached to the report in Open Software and were sent by name
              only: {skippedAttachmentNames.join(", ")}.
            </p>
          ) : null}
        </>
      ) : (
        <div
          className="dialog-body report-dialog-drop"
          data-drop-active={dropActive || undefined}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onPaste={handlePaste}
        >
          <SegmentedControl
            value={category}
            onValueChange={onCategoryChange}
            options={categoryOptions}
            className="report-dialog-category"
            aria-label="Report category"
          />
          <DialogField label="Description" htmlFor={descriptionId}>
            <textarea
              id={descriptionId}
              className="dialog-textarea"
              value={description}
              disabled={busy}
              rows={5}
              placeholder={reportCategoryDef(category)?.placeholder}
              onChange={(event) => {
                setError(null);
                onDescriptionChange(event.currentTarget.value);
              }}
            />
          </DialogField>
          {sessionContext ? (
            <ul className="report-dialog-file-list" aria-label="Included session context">
              <li className="report-dialog-file">
                <span className="report-dialog-file-name">
                  Visible conversation and sanitized diagnostics from{" "}
                  {sessionContext.title?.trim() || "this session"}
                </span>
                {onRemoveSessionContext ? (
                  <button
                    type="button"
                    aria-label="Remove session context"
                    disabled={busy}
                    onClick={onRemoveSessionContext}
                  >
                    <IconCrossSmall size={12} aria-hidden />
                  </button>
                ) : null}
              </li>
            </ul>
          ) : null}
          {attachments.length ? (
            <ul className="report-dialog-file-list" aria-label="Attached files">
              {attachments.map((attachment) => (
                <li key={attachment.id} className="report-dialog-file">
                  {attachment.previewDataUrl ? (
                    <img src={attachment.previewDataUrl} alt="" aria-hidden="true" />
                  ) : (
                    <FileTypeIcon name={attachment.name} size={14} />
                  )}
                  <span className="report-dialog-file-name">{attachment.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
                    disabled={busy}
                    onClick={() => onRemoveAttachment(attachment.id)}
                  >
                    <IconCrossSmall size={12} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {excessAttachmentCount > 0 ? (
            <p className="report-dialog-error" role="alert">
              Reports can include up to 20 attachments. Remove at least {excessAttachmentCount}{" "}
              {excessAttachmentCount === 1 ? "attachment" : "attachments"} before sending.
            </p>
          ) : error ? (
            <p className="report-dialog-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
