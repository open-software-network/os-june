import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { IconProjects } from "central-icons/IconProjects";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMicrophoneOff } from "central-icons/IconMicrophoneOff";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconMicrophone as IconMicrophoneLine } from "central-icons/IconMicrophone";
import { IconVolumeFull } from "central-icons/IconVolumeFull";
import { IconCalendar3 } from "central-icons/IconCalendar3";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconChevronBottom } from "central-icons-filled/IconChevronBottom";
import { IconMicrophone } from "central-icons-filled/IconMicrophone";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ReactNode, RefObject } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FundingTier } from "../account/FundingNotice";
import { Switch } from "../ui/Switch";
import type {
  FolderDto,
  LiveTranscriptEventDto,
  NoteDto,
  RecordingSourceMode,
  RecordingSourceReadinessDto,
  RecordingStatusDto,
  RecoverableRecordingDto,
  TranscriptDto,
} from "../../lib/tauri";
import { DotSpinner } from "../DotSpinner";
import { InlineNotice } from "../ui/InlineNotice";
import { CopyStateIcon } from "../ui/CopyStateIcon";
import { HoverTip } from "../ui/HoverTip";
import { SegmentedControl } from "../ui/SegmentedControl";
import { RecorderBar } from "../recorder/RecorderBar";
import { NoteRecoveryPrompt } from "../recorder/NoteRecoveryPrompt";
import { isMacLikePlatform } from "../../lib/platform";
import { useDismiss } from "../../lib/use-dismiss";
import { systemAudioAvailability } from "../../lib/source-readiness";
import {
  coalesceLiveTranscriptEventsForDisplay,
  reconcileLiveTranscriptEvents,
  transcriptFollowLatestKey,
} from "../../lib/live-transcript-preview";
import { useFollowLatestScroll } from "../../lib/use-follow-latest-scroll";
import {
  isInvalidJuneResponseMessage,
  NoteFailureBanner,
  userFacingFailureMessage,
} from "./NoteFailureBanner";
import { NotePreview } from "./NotePreview";

type NoteEditorProps = {
  note: NoteDto;
  transcriptScrollRef?: RefObject<HTMLElement | null>;
  folders: FolderDto[];
  recordingStatus?: RecordingStatusDto;
  recordingDisabled?: boolean;
  recordingBlockedReason?: string;
  retryBlockedReason?: string;
  /** The persistent out-of-credits notice, pre-wired by App. When present it
   * replaces the plain record-blocked InlineNotice in the editor footer. */
  fundingNotice?: ReactNode;
  /** The user's current plan, for the failed-note banner's tier card. */
  fundingTier?: FundingTier;
  recoveryBlockedReason?: string;
  liveTranscript?: LiveTranscriptEventDto[];
  sourceMode: RecordingSourceMode;
  sourceReadiness?: RecordingSourceReadinessDto;
  recovery?: RecoverableRecordingDto;
  onTitleChange: (title: string) => void;
  onContentChange: (noteId: string, content: string) => void;
  onSourceModeChange: (mode: RecordingSourceMode) => void;
  onEnableSystemAudio: () => void;
  onEnableMicrophone: () => void;
  microphoneBlocked: boolean;
  /** Dev-only: pin the consent reminder open past its reveal/auto-hide timers so
   * the dev console driver (window.__recordNoticesDemo) can park it for styling
   * review. Undefined in production, so the recorder timers run untouched. */
  consentReminderPinned?: boolean;
  onStartRecording: () => void;
  onPauseRecording: (sessionId: string) => void;
  onResumeRecording: (sessionId: string) => void;
  onFinishRecording: (sessionId: string) => void;
  onRetry: () => void | Promise<void>;
  onTopUp: () => void;
  topUpLabel?: string;
  onRecoverRecording: (sessionId: string) => void;
  onDiscardRecording: (sessionId: string) => void;
  onAssignFolder: (folderId: string) => void;
  onRemoveFolder: (folderId: string) => void;
  onCreateAndAssignFolder: (name: string) => void;
  onNavigateToFolder?: (folderId: string) => void;
  onTabChange: (tab: "notes" | "transcription") => void;
};

const TABS = [
  { value: "notes", label: "Notes" },
  { value: "transcription", label: "Transcription" },
] as const;
const NOTE_TITLE_PLACEHOLDER = "New note";

function sourceLabel(source?: string) {
  return source === "system" ? "System" : "Microphone";
}

/** Normalise a turn's source to one of the two filterable buckets — an
 * absent source is treated as microphone, matching sourceLabel. */
function sourceKey(source?: string): "microphone" | "system" {
  return source === "system" ? "system" : "microphone";
}

type SourceFilter = "all" | "microphone" | "system";

type RenderedTranscriptTurn = TranscriptDto & {
  preview?: boolean;
  stability?: LiveTranscriptEventDto["stability"];
};

type ProcessingStageStatus = Extract<
  NoteDto["processingStatus"],
  "validating" | "transcribing" | "generating"
>;

const SOURCE_FILTERS = [
  { value: "all", label: "All" },
  { value: "microphone", label: "Microphone" },
  { value: "system", label: "System" },
] as const;

const RECORD_CONSENT_REVEAL_DELAY_MS = 420;
const RECORD_CONSENT_AUTO_HIDE_MS = 5000;

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

function formatCalendarEventTime(startAt: string, endAt: string) {
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const day = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(start);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${day}, ${time.format(start)} to ${time.format(end)}`;
}

export function NoteEditor({
  note,
  transcriptScrollRef,
  folders,
  recordingStatus,
  recordingDisabled = false,
  recordingBlockedReason,
  retryBlockedReason,
  fundingNotice,
  fundingTier,
  recoveryBlockedReason,
  liveTranscript = [],
  sourceMode,
  sourceReadiness,
  recovery,
  onTitleChange,
  onContentChange,
  onSourceModeChange,
  onEnableSystemAudio,
  onEnableMicrophone,
  microphoneBlocked,
  consentReminderPinned,
  onStartRecording,
  onPauseRecording,
  onResumeRecording,
  onFinishRecording,
  onRetry,
  onTopUp,
  topUpLabel,
  onRecoverRecording,
  onDiscardRecording,
  onAssignFolder,
  onRemoveFolder,
  onCreateAndAssignFolder,
  onNavigateToFolder,
  onTabChange,
}: NoteEditorProps) {
  const content = note.editedContent ?? note.generatedContent ?? "";
  const activeTab = note.activeTab ?? "notes";
  const sourceTranscripts = orderedVisibleSourceTranscripts(note);
  const reconciledLiveTranscript = useMemo(
    () => reconcileLiveTranscriptEvents(liveTranscript, note.sourceTranscripts ?? []),
    [liveTranscript, note.sourceTranscripts],
  );
  const liveTranscriptTurns = useMemo(
    () =>
      coalesceLiveTranscriptEventsForDisplay(reconciledLiveTranscript).map(
        liveTranscriptEventToTurn,
      ),
    [reconciledLiveTranscript],
  );
  const transcriptTurns = useMemo(
    () =>
      [...sourceTranscripts, ...liveTranscriptTurns]
        .map((turn, index) => ({ turn, index }))
        .sort(compareSourceTranscriptOrder)
        .map(({ turn }) => turn),
    [sourceTranscripts, liveTranscriptTurns],
  );
  const recordingForNote = recordingStatus;
  const recordingActive = Boolean(recordingForNote);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [consentReminderVisible, setConsentReminderVisible] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  // The source filter is ephemeral view state — reset it when navigating
  // to a different note so it never leaks across transcripts.
  useEffect(() => {
    setSourceFilter("all");
  }, [note.id]);

  // The filter only earns its place when both sources are present — a
  // mic-only voice memo has nothing to switch between. Built on the
  // already-pruned visible list so silent/error-only Sources don't count.
  const hasBothSources = useMemo(() => {
    let mic = false;
    let system = false;
    for (const turn of transcriptTurns) {
      if (sourceKey(turn.source) === "system") system = true;
      else mic = true;
      if (mic && system) return true;
    }
    return false;
  }, [transcriptTurns]);
  const visibleTurns = useMemo(() => {
    if (!hasBothSources || sourceFilter === "all") return transcriptTurns;
    return transcriptTurns.filter((turn) => sourceKey(turn.source) === sourceFilter);
  }, [transcriptTurns, hasBothSources, sourceFilter]);
  const systemOn = sourceMode === "microphonePlusSystem";
  const systemAvailability = systemAudioAvailability(sourceReadiness);
  const systemUnsupported = systemAvailability === "unsupported";
  // Denied and granted-but-uncapturable both mean the switch must not be
  // offered; only the recovery copy differs.
  const systemLocked = systemAvailability === "denied" || systemAvailability === "unavailable";
  const showRecordingOptions = isMacLikePlatform();
  // Mic denial is sourced from App, which combines the dictation helper's
  // grant with the Rust readiness probe of the main app's own TCC grant —
  // recording uses the latter, so either denial blocks the record button.
  const micDenied = microphoneBlocked;

  // Auto-close the options panel whenever a recording starts so the
  // shell can transition into the recorder bar cleanly.
  useEffect(() => {
    if (recordingForNote) setOptionsOpen(false);
  }, [recordingForNote]);
  const consentEdgeRef = useRef({ noteId: note.id, recording: false });
  useEffect(() => {
    // Dev driver (window.__recordNoticesDemo): show the reminder immediately and
    // skip the reveal timer so it can be parked for styling review. The edge ref
    // is still synced so releasing the pin resumes normal behavior cleanly.
    if (consentReminderPinned) {
      consentEdgeRef.current = { noteId: note.id, recording: recordingActive };
      setConsentReminderVisible(true);
      return;
    }
    const prev = consentEdgeRef.current;
    const shouldReveal =
      prev.noteId !== note.id ? recordingActive : recordingActive && !prev.recording;

    consentEdgeRef.current = { noteId: note.id, recording: recordingActive };
    // Undo the ref mutation on cleanup so StrictMode's double-invoke replays
    // the same edge — otherwise the second invoke sees its own write and the
    // reminder never appears in development.
    const restoreEdge = () => {
      consentEdgeRef.current = prev;
    };

    if (!recordingActive) {
      setConsentReminderVisible(false);
      return restoreEdge;
    }

    if (!shouldReveal) return restoreEdge;

    setConsentReminderVisible(false);
    const timer = window.setTimeout(
      () => setConsentReminderVisible(true),
      RECORD_CONSENT_REVEAL_DELAY_MS,
    );
    return () => {
      window.clearTimeout(timer);
      restoreEdge();
    };
  }, [note.id, recordingActive, consentReminderPinned]);

  useEffect(() => {
    // A pinned reminder (dev driver) is held until "clear" or Dismiss, never
    // auto-hidden.
    if (!consentReminderVisible || consentReminderPinned) return;
    const timer = window.setTimeout(
      () => setConsentReminderVisible(false),
      RECORD_CONSENT_AUTO_HIDE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [consentReminderVisible, consentReminderPinned]);
  const processingStatus = processingStageStatus(note.processingStatus);
  const processingLock = processingStatus !== null;
  const recordButtonDisabled = recordingDisabled || Boolean(recordingBlockedReason);
  // A funding block disables the record button but not the options chevron:
  // choosing sources is free, and note processing can queue another recording,
  // so that setting stays reachable unless another recording is active.
  const recordOptionsDisabled = recordingDisabled;
  // When generation finishes for the note you're looking at, reveal the fresh
  // notes with a top-down wipe instead of letting the text snap in. Only fires
  // on the live processing -> ready edge for this same note — never when
  // opening an already-finished one. `justFinished` is derived during render
  // against the last commit, so the clip lands on the very first ready frame
  // (no chance of painting the notes un-clipped before the wipe starts);
  // `notesRevealing` then holds the class for the rest of the animation.
  const [notesRevealing, setNotesRevealing] = useState(false);
  const revealEdgeRef = useRef({ noteId: note.id, processing: processingLock });
  const justFinished =
    revealEdgeRef.current.noteId === note.id &&
    revealEdgeRef.current.processing &&
    !processingLock &&
    note.processingStatus === "ready";
  useEffect(() => {
    revealEdgeRef.current = { noteId: note.id, processing: processingLock };
    if (justFinished) setNotesRevealing(true);
  }, [note.id, processingLock, note.processingStatus, justFinished]);
  // Hold the class just past the staggered block cascade, then drop it. (The
  // blocks finish at different times, so a timer is cleaner than chasing the
  // last animationend.)
  useEffect(() => {
    if (!notesRevealing) return;
    const timer = window.setTimeout(() => setNotesRevealing(false), 1200);
    return () => window.clearTimeout(timer);
  }, [notesRevealing]);
  const revealingNotes = justFinished || notesRevealing;
  // Shell snaps straight back to idle after stop — the body shimmer
  // covers the "still processing" affordance, and the record button
  // stays disabled via processingLock so nothing can re-trigger.
  const shellState = recordingForNote?.state ?? "idle";
  const processingText = processingMessage(note.processingStatus);
  const transcriptText = transcriptToText(note, liveTranscriptTurns);
  const fallbackTranscriptScrollRef = useRef<HTMLElement>(null);
  const transcriptDisplayContentKey = useMemo(
    () =>
      JSON.stringify([
        sourceFilter,
        transcriptFollowLatestKey(reconciledLiveTranscript, note.sourceTranscripts ?? []),
        note.transcript?.id ?? null,
        note.transcript?.text ?? null,
        note.transcript?.status ?? null,
        note.transcript?.lastError ?? null,
      ]),
    [note.sourceTranscripts, note.transcript, reconciledLiveTranscript, sourceFilter],
  );
  useFollowLatestScroll({
    scrollRef: transcriptScrollRef ?? fallbackTranscriptScrollRef,
    active: activeTab === "transcription",
    contentKey: transcriptDisplayContentKey,
    scopeKey: note.id,
    followOnActivate: recordingActive,
  });
  const transcriptCoverageNotice = transcriptCoverageNoticeText(note);
  const silentSourceNotice = silentSourceNoticeText(note);
  const showTranscriptProcessing = processingStatus !== null;
  const showLivePreviewWaiting =
    recordingForNote?.livePreviewEnabled === true && liveTranscriptTurns.length === 0;
  // Processing runs in the background and is queued per note, so a recording
  // that's still transcribing/generating no longer blocks starting another —
  // you can stack messages and they process in order. The record button only
  // blocks when the microphone isn't ready; handleStartRecording re-checks on
  // click and silently falls back to mic-only if system audio is denied.
  const queuedRecordings = note.queuedRecordings ?? 0;
  const queuedTooltipId = useId();
  const updatedAtLabel = formatFullDate(note.updatedAt);
  const calendarEventTime = note.calendarEvent
    ? formatCalendarEventTime(note.calendarEvent.startAt, note.calendarEvent.endAt)
    : null;

  return (
    <article className="note-editor">
      <header className="editor-header">
        <input
          className="note-title"
          aria-label="Note title"
          placeholder={NOTE_TITLE_PLACEHOLDER}
          value={note.title}
          onChange={(event) => onTitleChange(event.currentTarget.value)}
        />
        <div className="note-title-print" aria-hidden="true">
          {note.title.trim() || NOTE_TITLE_PLACEHOLDER}
        </div>
        {/* Metadata reads as the title's caption: sits below it, above the
            Notes/Transcription toggle. Navigation lives in the toolbar above. */}
        <div className="note-overline">
          <div className="note-overline-meta">
            <span className="note-overline-date">{updatedAtLabel}</span>
            <span className="note-overline-dot" aria-hidden="true" />
            <FolderChip
              folders={folders}
              folderIds={note.folderIds}
              onAssign={onAssignFolder}
              onRemove={onRemoveFolder}
              onCreateAndAssign={onCreateAndAssignFolder}
              onNavigateToFolder={onNavigateToFolder}
            />
          </div>
        </div>
        {note.calendarEvent ? (
          <div
            className="note-calendar-context"
            aria-label={`Matched to ${note.calendarEvent.title} in Google Calendar`}
            title={`Matched from ${note.calendarEvent.accountEmail}`}
          >
            <IconCalendar3 aria-hidden="true" />
            <span className="note-calendar-source">Google Calendar</span>
            {calendarEventTime ? (
              <>
                <span className="note-overline-dot" aria-hidden="true" />
                <span>{calendarEventTime}</span>
              </>
            ) : null}
            <span className="note-overline-dot" aria-hidden="true" />
            <span className="note-calendar-account">{note.calendarEvent.accountEmail}</span>
          </div>
        ) : null}
        <SegmentedControl
          aria-label="Note views"
          value={activeTab}
          options={TABS}
          onValueChange={onTabChange}
        />
      </header>

      <section className="editor-content">
        {recovery ? (
          <NoteRecoveryPrompt
            recovery={recovery}
            onRecover={onRecoverRecording}
            onDiscard={onDiscardRecording}
            disabled={processingLock}
            recoverBlockedReason={recoveryBlockedReason}
          />
        ) : null}
        {note.processingStatus === "transcribing" && note.lastError ? (
          <InlineNotice
            className="note-transcription-warning"
            tone="warning"
            role="alert"
            aria-label="Transcription warning"
            body={userFacingFailureMessage(note.lastError)}
          />
        ) : null}
        {note.processingStatus === "failed" ? (
          <NoteFailureBanner
            errorMessage={note.lastError}
            audioPreserved={!!(note.audio || note.audioSources?.length)}
            onRetry={onRetry}
            onTopUp={onTopUp}
            topUpLabel={topUpLabel}
            retryBlockedReason={retryBlockedReason}
            tier={fundingTier}
          />
        ) : null}
        {activeTab === "transcription" ? (
          <div className="transcript-view">
            {transcriptText ? (
              <div className="transcript-toolbar">
                {hasBothSources ? (
                  <SegmentedControl
                    className="transcript-source-filter"
                    aria-label="Filter transcript by source"
                    value={sourceFilter}
                    options={SOURCE_FILTERS}
                    onValueChange={setSourceFilter}
                  />
                ) : null}
                <CopyTranscriptButton
                  text={visibleTurns.length ? turnsToText(visibleTurns) : transcriptText}
                />
              </div>
            ) : null}
            {showLivePreviewWaiting ? (
              <div className="transcript-processing" role="status" aria-live="polite">
                <DotSpinner className="transcript-processing-spinner" />
                <span className="transcript-processing-label shimmer">
                  Listening for transcript preview...
                </span>
              </div>
            ) : showTranscriptProcessing && processingStatus ? (
              <ProcessingProgressIndicator
                className="transcript-processing-progress"
                status={processingStatus}
              />
            ) : null}
            {transcriptCoverageNotice ? (
              <p className="transcript-coverage-notice">{transcriptCoverageNotice}</p>
            ) : null}
            {silentSourceNotice ? (
              <p className="transcript-coverage-notice">{silentSourceNotice}</p>
            ) : null}
            {visibleTurns.length ? (
              <div className="source-transcripts">
                {visibleTurns.map((transcript) => (
                  <TranscriptTurn
                    key={transcript.id}
                    transcript={transcript}
                    preview={transcript.preview}
                  />
                ))}
              </div>
            ) : note.transcript?.text ? (
              <p>{note.transcript.text}</p>
            ) : showTranscriptProcessing ? null : (
              <div className="transcript-empty">
                <p>
                  {recordingActive
                    ? "Transcript preview will appear here while you record."
                    : (processingText ??
                      (note.processingStatus === "failed"
                        ? "No transcript was produced."
                        : (note.lastError ?? "No transcript is available yet.")))}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="note-body-stack">
            <div className={revealingNotes ? "note-reveal-active" : undefined}>
              <NotePreview
                noteId={note.id}
                markdown={content}
                onChange={onContentChange}
                emptyPlaceholder={
                  processingLock
                    ? ""
                    : "Hit record to capture a conversation, or just start typing your thoughts here"
                }
              />
            </div>
            {/* The badge is the whole wait state now — no skeleton, since the
                generated note's shape isn't ours to predict. It clears as the
                notes wipe in above it. */}
            {processingStatus ? (
              <ProcessingProgressIndicator
                status={processingStatus}
                queuedRecordings={queuedRecordings}
                queuedTooltipId={queuedTooltipId}
              />
            ) : null}
          </div>
        )}
      </section>

      <div className="editor-footer">
        {!recordingForNote
          ? (fundingNotice ??
            (recordingBlockedReason ? (
              <InlineNotice
                className="record-funding-blocked"
                aria-label="Recording needs credits"
                body={recordingBlockedReason}
                actions={
                  <button type="button" className="btn btn-secondary" onClick={onTopUp}>
                    {topUpLabel ?? "Upgrade"}
                  </button>
                }
              />
            ) : null))
          : null}
        {micDenied && !recordingForNote ? (
          <InlineNotice
            className="record-mic-blocked"
            role="alert"
            aria-label="Microphone access required"
            icon={<IconMicrophoneOff size={14} aria-hidden />}
            body="Microphone access is blocked. You can still write notes here."
            actions={
              <button type="button" className="btn btn-secondary" onClick={onEnableMicrophone}>
                Enable
              </button>
            }
          />
        ) : (
          <div className="record-dock">
            <AnimatePresence>
              {recordingForNote?.warnings?.length ? (
                <motion.div
                  key="source-warning"
                  className="record-consent-note"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                >
                  <InlineNotice
                    className="record-consent-note-surface"
                    aria-label="Recording source warning"
                    body={recordingForNote.warnings[0].message}
                  />
                </motion.div>
              ) : null}
              {recordingForNote && consentReminderVisible && !recordingForNote.warnings?.length ? (
                <motion.div
                  key="consent"
                  className="record-consent-note"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                >
                  <InlineNotice
                    className="record-consent-note-surface"
                    aria-label="Recording consent reminder"
                    body="Make sure everyone has agreed to be recorded."
                    actions={
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => setConsentReminderVisible(false)}
                      >
                        Dismiss
                      </button>
                    }
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
            <div
              className="record-shell"
              data-state={shellState}
              data-options-open={
                !recordingForNote && !recordOptionsDisabled && showRecordingOptions && optionsOpen
              }
            >
              {!recordingForNote && !recordOptionsDisabled && showRecordingOptions ? (
                <div
                  className="record-options-panel"
                  data-open={optionsOpen}
                  aria-hidden={!optionsOpen}
                >
                  <div className="record-options-panel-inner">
                    {systemUnsupported ? (
                      <p className="record-options-unsupported">
                        System audio requires macOS 14.2 or later.
                      </p>
                    ) : (
                      <div className="record-options-row" data-locked={systemLocked || undefined}>
                        <Switch
                          checked={systemOn}
                          disabled={systemLocked}
                          aria-labelledby="record-options-system"
                          onCheckedChange={(next) =>
                            onSourceModeChange(next ? "microphonePlusSystem" : "microphoneOnly")
                          }
                        />
                        <span id="record-options-system" className="record-options-label">
                          Capture system audio
                        </span>
                        {systemAvailability === "denied" ? (
                          <button
                            type="button"
                            className="btn btn-ghost record-options-enable"
                            onClick={onEnableSystemAudio}
                          >
                            Enable
                          </button>
                        ) : null}
                      </div>
                    )}
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
                        transition: {
                          duration: 0.12,
                          ease: [0.22, 1, 0.36, 1],
                        },
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
                        transition: {
                          duration: 0.12,
                          ease: [0.22, 1, 0.36, 1],
                        },
                      }}
                    >
                      <div className="record-idle">
                        {recordingBlockedReason ? (
                          <HoverTip
                            tip={recordingBlockedReason}
                            className="record-button-tip"
                            tabIndex={0}
                          >
                            <button
                              type="button"
                              className="record-button"
                              aria-label="Recording needs credits"
                              disabled={recordButtonDisabled}
                              onClick={onStartRecording}
                            >
                              <IconMicrophone size={20} />
                            </button>
                          </HoverTip>
                        ) : (
                          <button
                            type="button"
                            className="record-button"
                            aria-label={recordingDisabled ? "Recording in progress" : "Record"}
                            title={recordingDisabled ? "Recording in progress" : "Record"}
                            disabled={recordButtonDisabled}
                            onClick={onStartRecording}
                          >
                            <IconMicrophone size={20} />
                          </button>
                        )}
                        {showRecordingOptions && !recordOptionsDisabled ? (
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
                        ) : null}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        )}
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
  onNavigateToFolder,
}: {
  folders: FolderDto[];
  folderIds: string[];
  onAssign: (folderId: string) => void;
  onRemove: (folderId: string) => void;
  onCreateAndAssign: (name: string) => void;
  onNavigateToFolder?: (folderId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useDismiss(ref, open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    setQuery("");
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  const currentFolderId = folderIds[0];
  const currentFolder = folders.find((folder) => folder.id === currentFolderId);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return folders;
    return folders.filter((folder) => folder.name.toLowerCase().includes(normalized));
  }, [folders, query]);

  const trimmed = query.trim();
  const exactMatch = folders.some((folder) => folder.name.toLowerCase() === trimmed.toLowerCase());
  const showCreate = trimmed.length > 0 && !exactMatch;

  return (
    <div className="folder-chip-wrap" ref={ref}>
      <button
        type="button"
        className="move-to-folder-trigger"
        data-assigned={currentFolder !== undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconProjects size={14} />
        {currentFolder?.name ?? "Project"}
      </button>
      {currentFolder && onNavigateToFolder ? (
        <button
          type="button"
          className="move-to-folder-open"
          aria-label={`Open ${currentFolder.name}`}
          title={`Open ${currentFolder.name}`}
          onClick={() => {
            setOpen(false);
            onNavigateToFolder(currentFolder.id);
          }}
        >
          <IconChevronRightSmall size={13} />
        </button>
      ) : null}
      {open ? (
        <div className="move-to-folder-popover" role="menu">
          <div className="move-to-folder-search">
            <IconMagnifyingGlass size={13} />
            <input
              ref={searchRef}
              type="search"
              placeholder="Search or create project"
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
            {query ? (
              <button
                type="button"
                className="search-clear"
                aria-label="Clear search"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
              >
                <IconCrossSmall size={13} />
              </button>
            ) : null}
          </div>
          <div className="move-to-folder-list">
            {filtered.length > 0 ? (
              filtered.map((folder) => {
                const isAssigned = folder.id === currentFolderId;
                return (
                  <button
                    key={folder.id}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={isAssigned}
                    className="move-to-folder-item"
                    onClick={() => (isAssigned ? onRemove(folder.id) : onAssign(folder.id))}
                  >
                    <IconProjects size={14} />
                    <span className="move-to-folder-item-name">{folder.name}</span>
                    <span className="move-to-folder-item-check" aria-hidden>
                      {isAssigned ? "✓" : ""}
                    </span>
                  </button>
                );
              })
            ) : trimmed.length === 0 ? (
              <p className="move-to-folder-empty">No projects yet.</p>
            ) : null}
          </div>
          {/* Create sits under the results: matches, if any, come first — the
              common case is filing into an existing project. */}
          {showCreate ? (
            <>
              {filtered.length > 0 ? <div className="move-to-folder-divider" aria-hidden /> : null}
              <button
                type="button"
                className="move-to-folder-create"
                onClick={() => {
                  onCreateAndAssign(trimmed);
                  setOpen(false);
                }}
              >
                <IconPlusMedium size={14} />
                <span className="move-to-folder-item-name">Create “{trimmed}”</span>
                <span aria-hidden />
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ProcessingProgressIndicator({
  status,
  queuedRecordings = 0,
  queuedTooltipId,
  className,
}: {
  status: ProcessingStageStatus;
  queuedRecordings?: number;
  queuedTooltipId?: string;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const classes = ["note-processing-progress", className].filter(Boolean).join(" ");

  return (
    <div className={classes} data-status={status} role="status" aria-live="polite">
      <DotSpinner className="note-processing-progress-spinner" />
      {/* A departure-board roll: each stage label rises into the one-line
          window as the previous one lifts out, blurring through the hand-off so
          the change feels organic rather than a hard cut. popLayout keeps the
          entering label in flow (so the chip stays sized) while the leaving one
          is popped out to slide away. Reduced motion drops to a plain
          crossfade. */}
      <div className="note-processing-roll">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={status}
            className="note-processing-roll-item shimmer"
            initial={reduceMotion ? { opacity: 0 } : { y: "65%", opacity: 0, filter: "blur(5px)" }}
            animate={reduceMotion ? { opacity: 1 } : { y: "0%", opacity: 1, filter: "blur(0px)" }}
            exit={reduceMotion ? { opacity: 0 } : { y: "-65%", opacity: 0, filter: "blur(5px)" }}
            transition={{
              duration: reduceMotion ? 0.15 : 0.5,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            {processingStageMessage(status)}
          </motion.span>
        </AnimatePresence>
      </div>
      {queuedRecordings > 0 && queuedTooltipId ? (
        <span className="note-generating-count" tabIndex={0} aria-describedby={queuedTooltipId}>
          +{queuedRecordings}
          <span className="note-generating-tip" id={queuedTooltipId} role="tooltip">
            {queuedRecordings} more recording
            {queuedRecordings > 1 ? "s" : ""} queued
          </span>
        </span>
      ) : null}
    </div>
  );
}

function processingStageStatus(status: NoteDto["processingStatus"]): ProcessingStageStatus | null {
  switch (status) {
    case "validating":
    case "transcribing":
    case "generating":
      return status;
    default:
      return null;
  }
}

// The stage name as it reads in the rolling label and the spoken status. Kept
// ellipsis-free: the roll and track motion already carry the "in progress"
// sense, so the words can stay calm.
function processingStageMessage(status: ProcessingStageStatus): string {
  switch (status) {
    case "validating":
      return "Preparing audio";
    case "transcribing":
      return "Transcribing audio";
    case "generating":
      return "Generating notes";
  }
}

function processingMessage(status: NoteDto["processingStatus"]): string | null {
  switch (status) {
    case "validating":
      return "Preparing audio...";
    case "transcribing":
      return "Transcribing audio...";
    case "generating":
      return "Generating notes...";
    default:
      return null;
  }
}

function turnsToText(turns: RenderedTranscriptTurn[]): string {
  return turns
    .filter((turn) => turn.text.trim())
    .map((turn) => {
      const meta = formatTurnTime(turn.startMs, turn.endMs)
        ? `${sourceLabel(turn.source)} ${formatTurnTime(turn.startMs, turn.endMs)}`
        : sourceLabel(turn.source);
      return `${meta}\n${turn.text}`;
    })
    .join("\n\n");
}

function transcriptToText(note: NoteDto, liveTurns: RenderedTranscriptTurn[] = []): string {
  const sourceTurns = orderedVisibleSourceTranscripts(note);
  if (sourceTurns.length || liveTurns.length) {
    return turnsToText(
      [...sourceTurns, ...liveTurns]
        .map((turn, index) => ({ turn, index }))
        .sort(compareSourceTranscriptOrder)
        .map(({ turn }) => turn),
    );
  }
  return note.transcript?.text ?? "";
}

function transcriptCoverageNoticeText(note: NoteDto): string | null {
  const coverage = note.transcriptCoverage;
  if (!coverage?.warning) return null;
  const detectedSpeechMs = Math.max(0, coverage.detectedSpeechMs);
  const transcribedMs = Math.max(0, coverage.transcribedMs);
  const missingMs = Math.max(0, detectedSpeechMs - transcribedMs);
  const missingMinutes = Math.max(1, Math.floor(missingMs / 60_000));
  const detectedMinutes = Math.max(1, Math.floor(detectedSpeechMs / 60_000));
  return `Parts of this recording could not be transcribed. About ${missingMinutes} of ${detectedMinutes} minutes of detected speech are missing from this transcript.`;
}

// A source that recorded pure silence fails transcription with a targeted
// message, but a note can still finish ready on its other source; surface
// that message as a notice instead of leaving it buried in the turn list.
function silentSourceNoticeText(note: NoteDto): string | null {
  const silent = (note.sourceTranscripts ?? []).find(
    (turn) => turn.recordedSilence && !turn.text.trim() && turn.lastError,
  );
  return silent?.lastError ?? null;
}

function orderedVisibleSourceTranscripts(note: NoteDto): RenderedTranscriptTurn[] {
  return (note.sourceTranscripts ?? [])
    .filter((turn) => {
      if (turn.text.trim()) return true;
      return Boolean(turn.lastError);
    })
    .map((turn, index) => ({ turn, index }))
    .sort(compareSourceTranscriptOrder)
    .map(({ turn }) => turn);
}

function liveTranscriptEventToTurn(event: LiveTranscriptEventDto): RenderedTranscriptTurn {
  return {
    id: `live-${event.sessionId}-${event.source}-${event.segmentId}`,
    text: event.text,
    recordingSessionId: event.sessionId,
    sourceMode: event.sourceMode,
    source: event.source,
    startMs: event.startMs,
    endMs: event.endMs,
    turnIndex: undefined,
    language: event.language,
    status: "running",
    preview: true,
    stability: event.stability,
  };
}

function compareSourceTranscriptOrder(
  left: { turn: RenderedTranscriptTurn; index: number },
  right: { turn: RenderedTranscriptTurn; index: number },
) {
  const turnIndexOrder = compareOptionalNumber(left.turn.turnIndex, right.turn.turnIndex);
  if (turnIndexOrder !== 0) return turnIndexOrder;

  const startOrder = compareOptionalNumber(left.turn.startMs, right.turn.startMs);
  if (startOrder !== 0) return startOrder;

  const endOrder = compareOptionalNumber(left.turn.endMs, right.turn.endMs);
  if (endOrder !== 0) return endOrder;

  return left.index - right.index;
}

function compareOptionalNumber(left?: number, right?: number) {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left - right;
}

function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (copyResetTimerRef.current !== undefined) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    },
    [],
  );

  function showCopiedFeedback() {
    setCopied(true);
    if (copyResetTimerRef.current !== undefined) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copyResetTimerRef.current = undefined;
    }, 1600);
  }

  return { copied, showCopiedFeedback };
}

/** A single conversation turn in the Transcription tab. Mirrors the dictation
 * history row language: a source glyph, a light meta line, and the transcript
 * text — copy reveals on hover, long turns clamp to a "Show more" toggle. */
function TranscriptTurn({
  transcript,
  preview = false,
}: {
  transcript: RenderedTranscriptTurn;
  preview?: boolean;
}) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const { copied, showCopiedFeedback } = useCopyFeedback();
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  const isSystem = transcript.source === "system";
  const turnTime = formatTurnTime(transcript.startMs, transcript.endMs);
  const hasText = transcript.text.trim().length > 0;
  // Every turn is copyable — a turn where nothing was said still carries
  // its error ("No speech detected…"), which is worth being able to grab.
  // The error is run through userFacingFailureMessage so raw provider codes
  // never reach the clipboard (or the card below).
  const errorMessage = sourceTurnFailureMessage(transcript.lastError);
  const copyValue = hasText ? transcript.text : errorMessage;
  const canCopy = copyValue.trim().length > 0;

  // Measure whether the collapsed text overflows its line clamp so the
  // "Show more" toggle only appears when there's hidden content.
  useEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    const measure = () => setClamped(el.scrollHeight - el.clientHeight > 1);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [transcript.text, expanded]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(copyValue);
      showCopiedFeedback();
    } catch {
      // Clipboard can fail in restricted contexts; stay silent.
    }
  }

  return (
    <article className="transcript-turn" data-source={isSystem ? "system" : "microphone"}>
      <span className="transcript-turn-icon" aria-hidden>
        {isSystem ? <IconVolumeFull size={14} /> : <IconMicrophoneLine size={14} />}
      </span>
      <div className="transcript-turn-body">
        <div className="transcript-turn-meta">
          <span className="transcript-turn-source">{sourceLabel(transcript.source)}</span>
          {turnTime ? <time>{turnTime}</time> : null}
          {preview ? <span className="transcript-turn-preview">Live preview</span> : null}
        </div>
        {hasText ? (
          <p ref={textRef} className="transcript-turn-text" data-expanded={expanded || undefined}>
            {transcript.text}
          </p>
        ) : null}
        {clamped || expanded ? (
          <button
            type="button"
            className="transcript-turn-more"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
        {errorMessage ? <p className="source-transcript-error">{errorMessage}</p> : null}
      </div>
      {canCopy ? (
        <HoverTip compact width={104} tip={copied ? "Copied" : "Copy"} forceOpen={copied}>
          <button
            type="button"
            className="transcript-turn-copy"
            data-copied={copied || undefined}
            aria-label={copied ? "Copied" : "Copy turn"}
            onClick={() => void handleCopy()}
          >
            <CopyStateIcon copied={copied} />
          </button>
        </HoverTip>
      ) : null}
    </article>
  );
}

function sourceTurnFailureMessage(message?: string) {
  if (message && isInvalidJuneResponseMessage(message)) {
    return "Audio for this part could not be transcribed.";
  }
  return userFacingFailureMessage(message) ?? "";
}

function CopyTranscriptButton({ text }: { text: string }) {
  const { copied, showCopiedFeedback } = useCopyFeedback();

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      showCopiedFeedback();
    } catch {
      // Clipboard API can fail in restricted contexts; stay silent
      // rather than nag — the user can retry.
    }
  }

  return (
    <HoverTip compact width={104} tip={copied ? "Copied" : "Copy"} forceOpen={copied}>
      <button
        type="button"
        className="transcript-copy"
        onClick={() => void handleCopy()}
        data-copied={copied || undefined}
        aria-label={copied ? "Transcript copied" : "Copy transcript"}
      >
        <CopyStateIcon copied={copied} />
        Copy
      </button>
    </HoverTip>
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
