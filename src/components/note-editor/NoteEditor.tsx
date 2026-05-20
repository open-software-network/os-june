import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconFolder1 } from "central-icons/IconFolder1";
import { IconMicrophone } from "central-icons-filled/IconMicrophone";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type {
  FolderDto,
  NoteDto,
  RecordingSourceMode,
  RecordingSourceReadinessDto,
  RecordingStatusDto,
} from "../../lib/tauri";
import { SegmentedControl } from "../ui/SegmentedControl";
import { RecorderBar } from "../recorder/RecorderBar";
import { SourceModeControl } from "../recorder/SourceModeControl";
import { NotePreview } from "./NotePreview";

type NoteEditorProps = {
  note: NoteDto;
  folders: FolderDto[];
  recordingStatus?: RecordingStatusDto;
  sourceMode: RecordingSourceMode;
  sourceReadiness?: RecordingSourceReadinessDto;
  checkingSourceReadiness: boolean;
  onTitleChange: (title: string) => void;
  onContentChange: (content: string) => void;
  onSourceModeChange: (mode: RecordingSourceMode) => void;
  onStartRecording: () => void;
  onPauseRecording: (sessionId: string) => void;
  onResumeRecording: (sessionId: string) => void;
  onFinishRecording: (sessionId: string) => void;
  onRetry: () => void;
  onAssignFolder: (folderId: string) => void;
  onRemoveFolder: (folderId: string) => void;
  onTabChange: (tab: "notes" | "transcription") => void;
};

const TABS = [
  { value: "notes", label: "Notes" },
  { value: "transcription", label: "Transcription" },
] as const;

export function NoteEditor({
  note,
  folders,
  recordingStatus,
  sourceMode,
  sourceReadiness,
  checkingSourceReadiness,
  onTitleChange,
  onContentChange,
  onSourceModeChange,
  onStartRecording,
  onPauseRecording,
  onResumeRecording,
  onFinishRecording,
  onRetry,
  onAssignFolder,
  onRemoveFolder,
  onTabChange,
}: NoteEditorProps) {
  const content = note.editedContent ?? note.generatedContent ?? "";
  const activeTab = note.activeTab ?? "notes";
  const recordingForNote = recordingStatus;
  const shellState = recordingForNote?.state ?? "idle";
  const processing = transientStatus(note.processingStatus);
  const recordDisabled =
    checkingSourceReadiness ||
    (sourceReadiness?.sources.some(
      (source) => source.required && !source.ready,
    ) ??
      false);

  return (
    <article className="note-editor">
      <header className="editor-header">
        <div className="note-overline">
          <span className="note-overline-date">
            {formatFullDate(note.updatedAt)}
          </span>
          <span className="note-overline-dot" aria-hidden>
            ·
          </span>
          <FolderChip
            folders={folders}
            folderIds={note.folderIds}
            onAssign={onAssignFolder}
            onRemove={onRemoveFolder}
          />
          {processing ? (
            <span className="note-overline-status">
              <span className="status-dot" aria-hidden />
              {processing}
            </span>
          ) : null}
        </div>
        <input
          className="note-title"
          aria-label="Note title"
          placeholder="New note"
          value={note.title}
          onChange={(event) => onTitleChange(event.currentTarget.value)}
        />
        <SegmentedControl
          aria-label="Note views"
          value={activeTab}
          options={TABS}
          onValueChange={onTabChange}
        />
      </header>

      <section className="editor-content">
        {activeTab === "notes" &&
        (note.processingStatus === "transcribing" ||
          note.processingStatus === "generating" ||
          note.processingStatus === "validating") ? (
          <p className="note-generating" role="status" aria-live="polite">
            {note.processingStatus === "transcribing"
              ? "Transcribing audio…"
              : "Generating notes…"}
          </p>
        ) : null}
        {activeTab === "transcription" ? (
          <div className="transcript-view">
            {note.sourceTranscripts?.length ? (
              <div className="source-transcripts">
                {note.sourceTranscripts.map((transcript) => (
                  <section key={transcript.id}>
                    <h3>
                      {transcript.source === "system"
                        ? "System audio"
                        : "Microphone"}
                    </h3>
                    <p>{transcript.text}</p>
                    {transcript.lastError ? (
                      <p className="source-transcript-error">
                        {transcript.lastError}
                      </p>
                    ) : null}
                  </section>
                ))}
              </div>
            ) : note.transcript?.text ? (
              <p>{note.transcript.text}</p>
            ) : (
              <div className="empty-state">
                <p>{note.lastError ?? "No transcript is available yet."}</p>
                {note.audio || note.audioSources?.length ? (
                  <button type="button" onClick={onRetry}>
                    <IconArrowRotateClockwise size={14} />
                    Retry
                  </button>
                ) : null}
              </div>
            )}
          </div>
        ) : (
          <NotePreview
            noteId={note.id}
            markdown={content}
            onChange={onContentChange}
            emptyPlaceholder="Record or start writing..."
          />
        )}
      </section>

      <div className="editor-footer">
        <SourceModeControl
          value={sourceMode}
          disabled={!!recordingForNote}
          readiness={sourceReadiness}
          onChange={onSourceModeChange}
        />
        <div className="record-shell" data-state={shellState}>
          <AnimatePresence mode="wait" initial={false}>
            {recordingForNote ? (
              <motion.div
                key="recorder"
                style={{ width: "100%" }}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={{ duration: 0.14, ease: "easeOut" }}
              >
                <RecorderBar
                  status={recordingForNote}
                  onPause={onPauseRecording}
                  onResume={onResumeRecording}
                  onDone={onFinishRecording}
                />
              </motion.div>
            ) : (
              <motion.button
                key="record"
                type="button"
                className="record-button"
                aria-label="Record"
                title="Record"
                disabled={recordDisabled}
                onClick={onStartRecording}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.14, ease: "easeOut" }}
              >
                <IconMicrophone size={20} />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </article>
  );
}

function FolderChip({
  folders,
  folderIds,
  onAssign,
  onRemove,
}: {
  folders: FolderDto[];
  folderIds: string[];
  onAssign: (folderId: string) => void;
  onRemove: (folderId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const assigned = folders.filter((folder) => folderIds.includes(folder.id));
  const label =
    assigned.length > 0
      ? assigned.map((folder) => folder.name).join(", ")
      : "Add to folder";

  return (
    <div className="folder-chip-wrap" ref={ref}>
      <button
        type="button"
        className="folder-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconFolder1 size={13} />
        {label}
      </button>
      {open ? (
        <div className="folder-popover" role="menu">
          {folders.length > 0 ? (
            folders.map((folder) => {
              const isAssigned = folderIds.includes(folder.id);
              return (
                <button
                  key={folder.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={isAssigned}
                  onClick={() =>
                    isAssigned ? onRemove(folder.id) : onAssign(folder.id)
                  }
                >
                  <span className="folder-popover-check">
                    {isAssigned ? "✓" : ""}
                  </span>
                  {folder.name}
                </button>
              );
            })
          ) : (
            <p className="folder-popover-empty">No folders yet</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* Status is only worth surfacing while something is actually happening —
 * a steady-state "Draft"/"Ready" badge is noise, so we drop it. */
function transientStatus(status: NoteDto["processingStatus"]): string | null {
  switch (status) {
    case "recording":
      return "Recording";
    case "validating":
      return "Validating";
    case "transcribing":
      return "Transcribing";
    case "generating":
      return "Writing notes";
    case "failed":
      return "Needs attention";
    case "recoverable":
      return "Recoverable";
    default:
      return null;
  }
}

function formatFullDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Today";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}
