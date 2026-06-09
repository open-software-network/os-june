import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteEditor } from "../components/note-editor/NoteEditor";
import type { NoteDto, RecoverableRecordingDto } from "../lib/tauri";

const now = "2026-05-19T10:00:00Z";

function note(overrides: Partial<NoteDto> = {}): NoteDto {
  return {
    id: "note-1",
    title: "Generated note",
    preview: "Preview",
    processingStatus: "ready",
    folderIds: [],
    createdAt: now,
    updatedAt: now,
    generatedContent: "## Section one\n\n- First point\n- Second point",
    activeTab: "notes",
    ...overrides,
  };
}

const props = {
  folders: [],
  sourceMode: "microphonePlusSystem" as const,
  checkingSourceReadiness: false,
  onTitleChange: vi.fn(),
  onContentChange: vi.fn(),
  onSourceModeChange: vi.fn(),
  onEnableSystemAudio: vi.fn(),
  onEnableMicrophone: vi.fn(),
  microphoneBlocked: false,
  onStartRecording: vi.fn(),
  onPauseRecording: vi.fn(),
  onResumeRecording: vi.fn(),
  onFinishRecording: vi.fn(),
  onRetry: vi.fn(),
  onTopUp: vi.fn(),
  onRecoverRecording: vi.fn(),
  onDiscardRecording: vi.fn(),
  onAssignFolder: vi.fn(),
  onRemoveFolder: vi.fn(),
  onCreateAndAssignFolder: vi.fn(),
  onNavigateToFolders: vi.fn(),
  onNavigateToFolder: vi.fn(),
  onTabChange: vi.fn(),
};

const recovery: RecoverableRecordingDto = {
  sessionId: "session-1",
  noteId: "note-1",
  startedAt: now,
  partialPathPresent: true,
  finalPathPresent: false,
  bytesFound: 4096,
};

describe("NoteEditor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("edits title and renders the generated note as a preview", async () => {
    const user = userEvent.setup();
    const onTitleChange = vi.fn();
    render(
      <NoteEditor {...props} note={note()} onTitleChange={onTitleChange} />,
    );

    await user.type(screen.getByLabelText("Note title"), " updated");
    expect(onTitleChange).toHaveBeenCalled();

    // The note body is a rendered preview, not an editable textarea.
    expect(screen.getByText("Section one")).toBeInTheDocument();
    expect(screen.getByText("First point")).toBeInTheDocument();
  });

  it("shows raw transcript in transcription tab", () => {
    render(
      <NoteEditor
        {...props}
        note={note({
          activeTab: "transcription",
          transcript: {
            id: "transcript-1",
            text: "Exact raw transcript",
            status: "succeeded",
          },
        })}
      />,
    );

    expect(screen.getByText("Exact raw transcript")).toBeInTheDocument();
  });

  it("shows source transcript turns with labels and timing", () => {
    render(
      <NoteEditor
        {...props}
        note={note({
          activeTab: "transcription",
          sourceTranscripts: [
            {
              id: "turn-1",
              text: "System playback text",
              source: "system",
              startMs: 1000,
              endMs: 2500,
              turnIndex: 0,
              status: "succeeded",
            },
            {
              id: "turn-2",
              text: "Microphone response",
              source: "microphone",
              startMs: 3000,
              endMs: 4500,
              turnIndex: 1,
              status: "succeeded",
            },
          ],
        })}
      />,
    );

    // Scope to the turn labels — the source filter (shown when both
    // sources are present) also renders "System"/"Microphone" options.
    expect(
      screen.getByText("System", { selector: ".transcript-turn-source" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Microphone", { selector: ".transcript-turn-source" }),
    ).toBeInTheDocument();
    expect(screen.getByText("0:01-0:03")).toBeInTheDocument();
    expect(screen.getByText("System playback text")).toBeInTheDocument();
    expect(screen.getByText("Microphone response")).toBeInTheDocument();
  });

  it("shows friendly source transcript failure reasons", () => {
    render(
      <NoteEditor
        {...props}
        note={note({
          activeTab: "transcription",
          sourceTranscripts: [
            {
              id: "turn-1",
              text: "",
              source: "microphone",
              startMs: 1000,
              endMs: 14_000,
              turnIndex: 0,
              status: "failed",
              lastError: "upstream_provider_failed; no_speech",
            },
          ],
        })}
      />,
    );

    expect(screen.getByText(/No speech detected/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/upstream_provider_failed/i),
    ).not.toBeInTheDocument();
  });

  it("does not render whole-note failures as transcript turns", () => {
    render(
      <NoteEditor
        {...props}
        note={note({
          activeTab: "transcription",
          processingStatus: "failed",
          lastError:
            "Microphone: No speech detected. Try speaking louder or moving closer to the microphone.",
          sourceTranscripts: [
            {
              id: "turn-1",
              text: "",
              source: "microphone",
              startMs: 15_000,
              endMs: 18_000,
              turnIndex: 0,
              status: "failed",
              lastError:
                "No speech detected. Try speaking louder or moving closer to the microphone.",
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Transcription failed")).toBeInTheDocument();
    expect(screen.queryByText("Microphone")).not.toBeInTheDocument();
    expect(screen.queryByText("0:15-0:18")).not.toBeInTheDocument();
  });

  it("requests tab change when Transcription is selected", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(<NoteEditor {...props} note={note()} onTabChange={onTabChange} />);

    await user.click(screen.getByRole("button", { name: "Transcription" }));

    expect(onTabChange).toHaveBeenCalledWith("transcription");
  });

  it("keeps normal spaces inline while allowing # space to start an H1", async () => {
    const user = userEvent.setup();
    render(
      <NoteEditor
        {...props}
        note={note({ generatedContent: "", editedContent: "" })}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Generated note" });

    await user.click(editor);
    await user.type(editor, "hello world");

    expect(editor).toHaveTextContent("hello world");
    expect(editor.querySelector("h1")).toBeNull();

    await user.clear(editor);
    await user.type(editor, "# Heading");

    expect(editor.querySelector("h1")).toHaveTextContent("Heading");
  });

  it("does not erase generated append content that arrives while editing", async () => {
    const user = userEvent.setup();
    const onContentChange = vi.fn();
    const { rerender } = render(
      <NoteEditor
        {...props}
        onContentChange={onContentChange}
        note={note({
          generatedContent: "",
          editedContent: "Manual notes",
        })}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Generated note" });

    await user.click(editor);
    rerender(
      <NoteEditor
        {...props}
        onContentChange={onContentChange}
        note={note({
          generatedContent: "Generated note",
          editedContent: "Manual notes\n\nGenerated note",
        })}
      />,
    );
    fireEvent.blur(editor);

    expect(onContentChange).toHaveBeenLastCalledWith(
      "note-1",
      "Manual notes\n\nGenerated note",
    );
  });

  it("offers retry when transcript failed and audio exists", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <NoteEditor
        {...props}
        onRetry={onRetry}
        note={note({
          activeTab: "transcription",
          processingStatus: "failed",
          lastError: "Transcription failed",
          audio: {
            id: "audio-1",
            source: "microphone",
            format: "wav",
            durationMs: 1200,
            sizeBytes: 2048,
            checksum: "abc",
            createdAt: now,
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Retry/i }));

    expect(onRetry).toHaveBeenCalled();
  });

  it("keeps the record button available and hides retry while processing", () => {
    render(
      <NoteEditor
        {...props}
        note={note({
          activeTab: "transcription",
          processingStatus: "transcribing",
          audio: {
            id: "audio-1",
            source: "microphone",
            format: "wav",
            durationMs: 1200,
            sizeBytes: 2048,
            checksum: "abc",
            createdAt: now,
          },
        })}
      />,
    );

    // Processing is queued per note, so a recording still in flight no longer
    // blocks starting another take.
    expect(screen.getByRole("button", { name: "Record" })).toBeEnabled();
    expect(screen.getByText("Transcribing audio...")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });

  it("shows a queued count when a follow-up recording is stacked", () => {
    render(
      <NoteEditor
        {...props}
        note={note({
          processingStatus: "generating",
          generatedContent: "Earlier notes",
          activeTab: "notes",
          queuedRecordings: 1,
        })}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Generating notes");
    expect(status).toHaveTextContent("+1");
  });

  it("starts recording immediately without a consent gate", async () => {
    const user = userEvent.setup();
    const onStartRecording = vi.fn();
    render(
      <NoteEditor
        {...props}
        note={note()}
        recovery={recovery}
        onStartRecording={onStartRecording}
      />,
    );

    // An interrupted recording must not disable the record button.
    expect(screen.getByText("Interrupted recording")).toBeInTheDocument();

    const recordButton = screen.getByRole("button", { name: "Record" });
    expect(recordButton).toBeEnabled();

    await user.click(recordButton);

    // The click records straight away — no blocking dialog in the way.
    expect(onStartRecording).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("status", { name: "Recording consent reminder" }),
    ).not.toBeInTheDocument();
  });

  it("surfaces a dismissible consent reminder after the recorder settles", async () => {
    vi.useFakeTimers();
    render(
      <NoteEditor
        {...props}
        note={note()}
        recordingStatus={{
          sessionId: "session-1",
          state: "recording",
          elapsedMs: 1000,
          level: { peak: 0.5, rms: 0.2, recentPeaks: [0.1, 0.3] },
          silenceWarning: false,
          bytesWritten: 2048,
        }}
      />,
    );

    expect(
      screen.queryByRole("status", { name: "Recording consent reminder" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(419);
    });

    expect(
      screen.queryByRole("status", { name: "Recording consent reminder" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(
      screen.getByRole("status", { name: "Recording consent reminder" }),
    ).toHaveTextContent(/everyone has agreed to be recorded/i);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    // It fades out via AnimatePresence, so it lingers for the exit animation
    // before unmounting — advance past it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(
      screen.queryByRole("status", { name: "Recording consent reminder" }),
    ).not.toBeInTheDocument();
  });

  it("auto-hides the consent reminder after five seconds", async () => {
    vi.useFakeTimers();
    render(
      <NoteEditor
        {...props}
        note={note()}
        recordingStatus={{
          sessionId: "session-1",
          state: "recording",
          elapsedMs: 1000,
          level: { peak: 0.5, rms: 0.2, recentPeaks: [0.1, 0.3] },
          silenceWarning: false,
          bytesWritten: 2048,
        }}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(420);
    });

    expect(
      screen.getByRole("status", { name: "Recording consent reminder" }),
    ).toBeInTheDocument();

    // Just shy of the auto-hide window the reminder is still up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });

    expect(
      screen.getByRole("status", { name: "Recording consent reminder" }),
    ).toBeInTheDocument();

    // Cross the 5s mark so the auto-hide fires...
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    // ...then advance past the AnimatePresence exit fade.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(
      screen.queryByRole("status", { name: "Recording consent reminder" }),
    ).not.toBeInTheDocument();
  });

  it("keeps existing notes visible while showing processing status below them", () => {
    render(
      <NoteEditor
        {...props}
        note={note({
          processingStatus: "generating",
          generatedContent: "Existing notes stay visible",
          activeTab: "notes",
        })}
      />,
    );

    expect(screen.getByText("Existing notes stay visible")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Generating notes");
  });

  it("shows skeleton lines while generating and drops them once ready", () => {
    const { container, rerender } = render(
      <NoteEditor
        {...props}
        note={note({ processingStatus: "generating", activeTab: "notes" })}
      />,
    );

    expect(container.querySelectorAll(".note-skeleton-line")).toHaveLength(3);

    rerender(
      <NoteEditor
        {...props}
        note={note({
          processingStatus: "ready",
          generatedContent: "The notes",
          activeTab: "notes",
        })}
      />,
    );

    expect(container.querySelectorAll(".note-skeleton-line")).toHaveLength(0);
  });
});
