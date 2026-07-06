import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconPaperclip1 } from "central-icons/IconPaperclip1";
import { type DragEvent, useId, useMemo, useState } from "react";

import { messageFromError } from "../../lib/errors";
import { submitIssueReport } from "../../lib/tauri";
import { DotSpinner } from "../DotSpinner";
import { Dialog, DialogField } from "../ui/Dialog";
import { SegmentedControl } from "../ui/SegmentedControl";
import { CategoryIcon } from "./composer/CategoryIcon";
import {
  ISSUE_REPORT_ATTACHMENTS_ONLY_DESCRIPTION,
  REPORT_CATEGORIES,
  type ReportCategory,
} from "./composer/reportCategory";
import { FileTypeIcon } from "./FileTypeIcon";

export type ReportDialogAttachment = {
  id: string;
  name: string;
  path: string;
  previewDataUrl?: string | null;
};

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
  onClose,
  onSent,
}: ReportDialogProps) {
  const [dropActive, setDropActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Dropped-file imports resolve in the parent, and `importingFiles` only
  // reflects them a render later — count in-flight drops here too so a fast
  // "drop then send" cannot submit the report without the dropped file.
  const [dropsPending, setDropsPending] = useState(0);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descriptionId = useId();
  const trimmedDescription = description.trim();
  const canSubmit = Boolean(trimmedDescription || attachments.length);
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
    event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDropActive(false);
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) {
      setError("Drop files from Finder to attach them to the report.");
      return;
    }
    setError(null);
    setDropsPending((count) => count + 1);
    void Promise.resolve(onDropFiles(files)).finally(() => setDropsPending((count) => count - 1));
  }

  async function handleSubmit() {
    if (!canSubmit || busy) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitIssueReport({
        category,
        description: trimmedDescription || ISSUE_REPORT_ATTACHMENTS_ONLY_DESCRIPTION,
        attachmentNames: attachments.map((attachment) => attachment.name),
        attachmentPaths: attachments.map((attachment) => attachment.path),
      });
      setSubmitting(false);
      setSent(true);
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
        <p className="report-dialog-sent" role="status">
          Your report was sent to the June team. Thank you for helping improve June.
        </p>
      ) : (
        <div
          className="dialog-body report-dialog-drop"
          data-drop-active={dropActive || undefined}
          onDragOver={handleDragOver}
          onDragEnter={() => setDropActive(true)}
          onDragLeave={() => setDropActive(false)}
          onDrop={handleDrop}
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
              placeholder="Describe what happened"
              onChange={(event) => {
                setError(null);
                onDescriptionChange(event.currentTarget.value);
              }}
            />
          </DialogField>
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
          {error ? (
            <p className="report-dialog-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
