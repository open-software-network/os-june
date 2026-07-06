import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconFileText } from "central-icons/IconFileText";
import { type DragEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";

import { messageFromError } from "../../lib/errors";
import { submitIssueReport } from "../../lib/tauri";
import { DotSpinner } from "../DotSpinner";
import { SegmentedControl } from "../ui/SegmentedControl";
import { CategoryIcon } from "./composer/CategoryIcon";
import {
  ISSUE_REPORT_ATTACHMENTS_ONLY_DESCRIPTION,
  REPORT_CATEGORIES,
  type ReportCategory,
} from "./composer/reportCategory";
import { FileTypeIcon } from "./FileTypeIcon";

export type ReportPopoverAttachment = {
  id: string;
  name: string;
  path: string;
  previewDataUrl?: string | null;
};

type ReportPopoverProps = {
  category: ReportCategory;
  description: string;
  attachments: ReportPopoverAttachment[];
  importingFiles: boolean;
  popoverRef: RefObject<HTMLDivElement>;
  onCategoryChange: (category: ReportCategory) => void;
  onDescriptionChange: (description: string) => void;
  onAddFiles: () => unknown;
  onDropFiles: (files: File[]) => unknown;
  onRemoveAttachment: (id: string) => void;
  onClose: () => void;
  onSent: () => void;
};

export function ReportPopover({
  category,
  description,
  attachments,
  importingFiles,
  popoverRef,
  onCategoryChange,
  onDescriptionChange,
  onAddFiles,
  onDropFiles,
  onRemoveAttachment,
  onClose,
  onSent,
}: ReportPopoverProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Dropped-file imports resolve in the parent, and `importingFiles` only
  // reflects them a render later — count in-flight drops here too so a fast
  // "drop then send" cannot submit the report without the dropped file.
  const [dropsPending, setDropsPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
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
            <span className="agent-report-popover-category-label">{item.label}</span>
          </>
        ),
      })),
    [],
  );

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

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
      onSent();
    } catch (err) {
      setSubmitting(false);
      setError(`The issue report could not be sent. ${messageFromError(err)}`);
    }
  }

  return (
    <div
      ref={popoverRef}
      className="agent-report-popover"
      role="dialog"
      aria-label="Issue report"
      data-drop-active={dropActive || undefined}
      onDragOver={handleDragOver}
      onDragEnter={() => setDropActive(true)}
      onDragLeave={() => setDropActive(false)}
      onDrop={handleDrop}
    >
      <div className="agent-report-popover-header">
        <p className="agent-report-popover-title">Issue report</p>
        <button
          type="button"
          className="agent-report-popover-close"
          aria-label="Close issue report"
          onClick={onClose}
        >
          <IconCrossSmall size={14} aria-hidden />
        </button>
      </div>
      <SegmentedControl
        value={category}
        onValueChange={onCategoryChange}
        options={categoryOptions}
        className="agent-report-popover-category"
        aria-label="Report category"
      />
      <textarea
        ref={textareaRef}
        className="agent-report-popover-description"
        value={description}
        disabled={busy}
        rows={5}
        placeholder="Describe what happened"
        aria-label="Report description"
        onChange={(event) => {
          setError(null);
          onDescriptionChange(event.currentTarget.value);
        }}
      />
      <div className="agent-report-popover-attachments">
        <button
          type="button"
          className="agent-report-popover-add-files"
          disabled={busy}
          onClick={() => {
            setError(null);
            void onAddFiles();
          }}
        >
          <IconFileText size={16} aria-hidden />
          {importingFiles ? "Adding files" : "Add files"}
        </button>
        <span className="agent-report-popover-drop-label">Drop files here</span>
      </div>
      {attachments.length ? (
        <ul className="agent-report-popover-file-list" aria-label="Attached files">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="agent-report-popover-file">
              {attachment.previewDataUrl ? (
                <img src={attachment.previewDataUrl} alt="" aria-hidden="true" />
              ) : (
                <FileTypeIcon name={attachment.name} size={14} />
              )}
              <span className="agent-report-popover-file-name">{attachment.name}</span>
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
        <p className="agent-report-popover-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="agent-report-popover-actions">
        <button
          type="button"
          className="agent-report-popover-submit"
          disabled={!canSubmit || busy}
          onClick={() => void handleSubmit()}
        >
          {submitting ? <DotSpinner className="agent-report-popover-submit-spinner" /> : null}
          {submitting ? "Sending" : "Send report"}
        </button>
      </div>
    </div>
  );
}
