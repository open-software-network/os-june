import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconClipboard } from "central-icons/IconClipboard";
import { IconFolder1 } from "central-icons/IconFolder1";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconCheckmark1 } from "central-icons-filled/IconCheckmark1";
import { IconChevronBottom } from "central-icons-filled/IconChevronBottom";
import { IconMicrophone } from "central-icons-filled/IconMicrophone";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { Switch } from "../ui/Switch";
import type {
  FolderDto,
  NoteDto,
  RecordingSourceMode,
  RecordingSourceReadinessDto,
  RecordingStatusDto,
} from "../../lib/tauri";
import { SegmentedControl } from "../ui/SegmentedControl";
import { RecorderBar } from "../recorder/RecorderBar";
import { NotePreview } from "./NotePreview";

type NoteEditorProps = {
  note: NoteDto;
  folders: FolderDto[];
  recordingStatus?: RecordingStatusDto;
  sourceMode: RecordingSourceMode;
  sourceReadiness?: RecordingSourceReadinessDto;
  checkingSourceReadiness: boolean;
  onTitleChange: (title: string) => void;
  onContentChange: (noteId: string, content: string) => void;
  onSourceModeChange: (mode: RecordingSourceMode) => void;
  onStartRecording: () => void;
  onPauseRecording: (sessionId: string) => void;
  onResumeRecording: (sessionId: string) => void;
  onFinishRecording: (sessionId: string) => void;
  onRetry: () => void;
  onAssignFolder: (folderId: string) => void;
  onRemoveFolder: (folderId: string) => void;
  onCreateAndAssignFolder: (name: string) => void;
  onTabChange: (tab: "notes" | "transcription") => void;
};

const TABS = [
  { value: "notes", label: "Notes" },
  { value: "transcription", label: "Transcription" },
] as const;

function sourceLabel(source?: string) {
  return source === "system" ? "System" : "Microphone";
}

function formatTurnTime(startMs?: number, endMs?: number) {
  if (startMs === undefined || endMs === undefined || endMs <= startMs) {
    return null;
  }
  const format = (value: number) => {
    const seconds = Math.max(0, Math.round(value / 1000));
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  };
  return `${format(startMs)}-${format(endMs)}`;
}

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
  onCreateAndAssignFolder,
  onTabChange,
}: NoteEditorProps) {
  const content = note.editedContent ?? note.generatedContent ?? "";
  const activeTab = note.activeTab ?? "notes";
  const recordingForNote = recordingStatus;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const systemOn = sourceMode === "microphonePlusSystem";
  const systemReadiness = sourceReadiness?.sources.find(
    (source) => source.source === "system",
  );
  const systemBlocked = !!(systemReadiness && !systemReadiness.ready);

  // Auto-close the options panel whenever a recording starts so the
  // shell can transition into the recorder bar cleanly.
  useEffect(() => {
    if (recordingForNote) setOptionsOpen(false);
  }, [recordingForNote]);
  const processingLock =
    note.processingStatus === "transcribing" ||
    note.processingStatus === "generating" ||
    note.processingStatus === "validating";
  // Shell snaps straight back to idle after stop — the body shimmer
  // covers the "still processing" affordance, and the record button
  // stays disabled via processingLock so nothing can re-trigger.
  const shellState = recordingForNote?.state ?? "idle";
  const processing = transientStatus(note.processingStatus);
  const processingText = processingMessage(note.processingStatus);
  const canRetry =
    note.processingStatus === "failed" &&
    !!(note.audio || note.audioSources?.length);
  // Don't gate the record button on the background readiness check —
  // a quick toggle would briefly disable it and feel glitchy.
  // handleStartRecording re-runs a fresh check on click and surfaces any
  // error, so background readiness only informs the popover hint.
  const recordDisabled =
    processingLock ||
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
            onCreateAndAssign={onCreateAndAssignFolder}
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
        {activeTab === "transcription" ? (
          <div className="transcript-view">
            {transcriptToText(note) ? (
              <div className="transcript-toolbar">
                <CopyTranscriptButton text={transcriptToText(note)} />
              </div>
            ) : null}
            {note.sourceTranscripts?.length ? (
              <div className="source-transcripts">
                {note.sourceTranscripts.map((transcript) => {
                  const turnTime = formatTurnTime(
                    transcript.startMs,
                    transcript.endMs,
                  );
                  return (
                    <section className="transcript-turn" key={transcript.id}>
                      <div className="transcript-turn-meta">
                        <span>{sourceLabel(transcript.source)}</span>
                        {turnTime ? <time>{turnTime}</time> : null}
                      </div>
                      <p>{transcript.text}</p>
                      {transcript.lastError ? (
                        <p className="source-transcript-error">
                          {transcript.lastError}
                        </p>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            ) : note.transcript?.text ? (
              <p>{note.transcript.text}</p>
            ) : (
              <div className="empty-state">
                <p>
                  {processingText ??
                    note.lastError ??
                    "No transcript is available yet."}
                </p>
                {canRetry ? (
                  <button type="button" onClick={onRetry}>
                    <IconArrowRotateClockwise size={14} />
                    Retry
                  </button>
                ) : null}
              </div>
            )}
          </div>
        ) : (
          <div className="note-body-stack">
            <NotePreview
              noteId={note.id}
              markdown={content}
              onChange={onContentChange}
              emptyPlaceholder="Hit record to capture a conversation, or just start typing your thoughts here"
            />
            {processingLock ? (
              <p
                className="note-generating"
                role="status"
                aria-live="polite"
              >
                {note.processingStatus === "generating"
                  ? "Generating notes…"
                  : "Transcribing audio…"}
              </p>
            ) : null}
          </div>
        )}
      </section>

      <div className="editor-footer">
        <div
          className="record-shell"
          data-state={shellState}
          data-options-open={!recordingForNote && !processingLock && optionsOpen}
        >
          {!recordingForNote && !processingLock ? (
            <div
              className="record-options-panel"
              data-open={optionsOpen}
              aria-hidden={!optionsOpen}
            >
              <div className="record-options-panel-inner">
                <div className="record-options-row">
                  <Switch
                    checked={systemOn}
                    disabled={systemBlocked && !systemOn}
                    aria-labelledby="record-options-system"
                    onCheckedChange={(next) =>
                      onSourceModeChange(
                        next ? "microphonePlusSystem" : "microphoneOnly",
                      )
                    }
                  />
                  <span
                    id="record-options-system"
                    className="record-options-label"
                  >
                    Capture system audio
                    {systemBlocked ? (
                      <span className="record-options-hint">
                        {systemReadiness?.message ?? "Not available"}
                      </span>
                    ) : null}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
          <div className="record-stage">
            <AnimatePresence initial={false}>
              {recordingForNote ? (
                <motion.div
                  key="recorder"
                  className="record-state record-state-recorder"
                  initial={{ opacity: 0 }}
                  animate={{
                    opacity: 1,
                    transition: {
                      duration: 0.22,
                      delay: 0.14,
                      ease: [0.22, 1, 0.36, 1],
                    },
                  }}
                  exit={{
                    opacity: 0,
                    transition: { duration: 0.12, ease: [0.22, 1, 0.36, 1] },
                  }}
                >
                  <RecorderBar
                    status={recordingForNote}
                    onPause={onPauseRecording}
                    onResume={onResumeRecording}
                    onDone={onFinishRecording}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="idle"
                  className="record-state record-state-idle"
                  initial={{ opacity: 0 }}
                  animate={{
                    opacity: 1,
                    // Symmetric to the recorder enter — delay the reveal
                    // so the idle pill resolves as the shell finishes
                    // collapsing back, not while it's still wide.
                    transition: {
                      duration: 0.22,
                      delay: 0.12,
                      ease: [0.22, 1, 0.36, 1],
                    },
                  }}
                  exit={{
                    opacity: 0,
                    transition: { duration: 0.12, ease: [0.22, 1, 0.36, 1] },
                  }}
                >
                  <div className="record-idle">
                    <button
                      type="button"
                      className="record-button"
                      aria-label="Record"
                      title="Record"
                      disabled={recordDisabled}
                      onClick={onStartRecording}
                    >
                      <IconMicrophone size={20} />
                    </button>
                    <button
                      type="button"
                      className="record-options-trigger"
                      aria-label="Recording options"
                      aria-expanded={optionsOpen}
                      data-rotated={optionsOpen}
                      onClick={() => setOptionsOpen((value) => !value)}
                    >
                      <IconChevronBottom size={16} />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
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
  onCreateAndAssign,
}: {
  folders: FolderDto[];
  folderIds: string[];
  onAssign: (folderId: string) => void;
  onRemove: (folderId: string) => void;
  onCreateAndAssign: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    function onClick(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const assigned = folders.filter((folder) => folderIds.includes(folder.id));
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return folders;
    return folders.filter((folder) =>
      folder.name.toLowerCase().includes(normalized),
    );
  }, [folders, query]);

  const trimmed = query.trim();
  const exactMatch = folders.some(
    (folder) => folder.name.toLowerCase() === trimmed.toLowerCase(),
  );
  const showCreate = trimmed.length > 0 && !exactMatch;

  return (
    <div className="folder-chip-wrap" ref={ref}>
      <button
        type="button"
        className="move-to-folder-trigger"
        data-assigned={assigned.length > 0}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconFolder1 size={13} />
        {assigned.length > 0
          ? assigned.map((folder) => folder.name).join(", ")
          : "Folder"}
      </button>
      {open ? (
        <div className="move-to-folder-popover" role="menu">
          <div className="move-to-folder-search">
            <IconMagnifyingGlass size={12} />
            <input
              ref={searchRef}
              type="search"
              placeholder="Search or create folder"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && showCreate) {
                  event.preventDefault();
                  onCreateAndAssign(trimmed);
                  setOpen(false);
                }
              }}
            />
          </div>
          {showCreate ? (
            <>
              <button
                type="button"
                className="move-to-folder-create"
                onClick={() => {
                  onCreateAndAssign(trimmed);
                  setOpen(false);
                }}
              >
                <IconPlusMedium size={12} />
                <span className="move-to-folder-item-name">
                  Create “{trimmed}”
                </span>
                <span aria-hidden />
              </button>
              <div className="move-to-folder-divider" aria-hidden />
            </>
          ) : null}
          <div className="move-to-folder-list">
            {filtered.length > 0 ? (
              filtered.map((folder) => {
                const isAssigned = folderIds.includes(folder.id);
                return (
                  <button
                    key={folder.id}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={isAssigned}
                    className="move-to-folder-item"
                    onClick={() =>
                      isAssigned ? onRemove(folder.id) : onAssign(folder.id)
                    }
                  >
                    <IconFolder1 size={12} />
                    <span className="move-to-folder-item-name">
                      {folder.name}
                    </span>
                    <span className="move-to-folder-item-check" aria-hidden>
                      {isAssigned ? "✓" : ""}
                    </span>
                  </button>
                );
              })
            ) : trimmed.length === 0 ? (
              <p className="move-to-folder-empty">No folders yet.</p>
            ) : null}
          </div>
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

function processingMessage(status: NoteDto["processingStatus"]): string | null {
  switch (status) {
    case "transcribing":
      return "Transcribing audio...";
    case "generating":
      return "Generating note...";
    default:
      return null;
  }
}

function transcriptToText(note: NoteDto): string {
  if (note.sourceTranscripts?.length) {
    return note.sourceTranscripts
      .map((turn) => {
        const meta = formatTurnTime(turn.startMs, turn.endMs)
          ? `${sourceLabel(turn.source)} ${formatTurnTime(turn.startMs, turn.endMs)}`
          : sourceLabel(turn.source);
        return `${meta}\n${turn.text}`;
      })
      .join("\n\n");
  }
  return note.transcript?.text ?? "";
}

function CopyTranscriptButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard API can fail in restricted contexts; stay silent
      // rather than nag — the user can retry.
    }
  }

  return (
    <button
      type="button"
      className="transcript-copy"
      onClick={() => void handleCopy()}
      data-copied={copied || undefined}
      aria-label={copied ? "Transcript copied" : "Copy transcript"}
      title={copied ? "Copied" : "Copy transcript"}
    >
      {copied ? <IconCheckmark1 size={14} /> : <IconClipboard size={14} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
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
