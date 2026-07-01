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

function stubNavigatorPlatform(platform: string, userAgent: string) {
  const ownPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
  const ownUserAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    get: () => platform,
  });
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    get: () => userAgent,
  });
  return () => {
    if (ownPlatform) {
      Object.defineProperty(navigator, "platform", ownPlatform);
    } else {
      Reflect.deleteProperty(navigator, "platform");
    }
    if (ownUserAgent) {
      Object.defineProperty(navigator, "userAgent", ownUserAgent);
    } else {
      Reflect.deleteProperty(navigator, "userAgent");
    }
  };
}

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

  it("shows live transcript preview turns while recording", () => {
    render(
      <NoteEditor
        {...props}
        note={note({ activeTab: "transcription" })}
        recordingStatus={{
          sessionId: "session-1",
          state: "recording",
          elapsedMs: 8000,
          level: { peak: 0.5, rms: 0.2, recentPeaks: [0.1, 0.3] },
          silenceWarning: false,
          bytesWritten: 4096,
        }}
        liveTranscript={[
          {
            noteId: "note-1",
            sessionId: "session-1",
            sourceMode: "microphoneOnly",
            source: "microphone",
            segmentId: "microphone-0",
            startMs: 0,
            endMs: 8000,
            text: "Preview words from the live recording",
            language: "en",
            stability: "final",
          },
        ]}
      />,
    );

    expect(
      screen.getByText("Preview words from the live recording"),
    ).toBeInTheDocument();
    expect(screen.getByText("Live preview")).toBeInTheDocument();
  });

  it("only shows the live preview waiting state when preview is enabled", () => {
    const recordingStatus = {
      sessionId: "session-1",
      state: "recording" as const,
      elapsedMs: 8000,
      level: { peak: 0.5, rms: 0.2, recentPeaks: [0.1, 0.3] },
      silenceWarning: false,
      bytesWritten: 4096,
    };
    const { rerender } = render(
      <NoteEditor
        {...props}
        note={note({ activeTab: "transcription" })}
        recordingStatus={recordingStatus}
      />,
    );

    expect(
      screen.queryByText("Listening for transcript preview..."),
    ).not.toBeInTheDocument();

    rerender(
      <NoteEditor
        {...props}
        note={note({ activeTab: "transcription" })}
        recordingStatus={{
          ...recordingStatus,
          livePreviewEnabled: true,
        }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Listening for transcript preview...",
    );
  });

  it("shows transcript progress while retrying over existing turns", () => {
    render(
      <NoteEditor
        {...props}
        note={note({
          activeTab: "transcription",
          processingStatus: "transcribing",
          sourceTranscripts: [
            {
              id: "turn-1",
              text: "Previous system transcript",
              source: "system",
              startMs: 1000,
              endMs: 2500,
              turnIndex: 0,
              status: "succeeded",
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Transcribing audio");
    expect(screen.getByRole("status")).toHaveAttribute(
      "data-status",
      "transcribing",
    );
    expect(screen.getByText("Previous system transcript")).toBeInTheDocument();
  });

  it("shows transcript progress before any transcript text exists", () => {
    render(
      <NoteEditor
        {...props}
        note={note({
          activeTab: "transcription",
          processingStatus: "transcribing",
        })}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Transcribing audio");
    expect(screen.getByRole("status")).toHaveAttribute(
      "data-status",
      "transcribing",
    );
    expect(screen.queryByText("No transcript is available yet.")).toBeNull();
  });

  it("orders source transcript turns by persisted turn metadata", () => {
    const { container } = render(
      <NoteEditor
        {...props}
        note={note({
          activeTab: "transcription",
          sourceTranscripts: [
            {
              id: "turn-3",
              text: "Second microphone turn",
              source: "microphone",
              startMs: 5000,
              endMs: 6500,
              turnIndex: 2,
              status: "succeeded",
            },
            {
              id: "turn-1",
              text: "First microphone turn",
              source: "microphone",
              startMs: 1000,
              endMs: 2000,
              turnIndex: 0,
              status: "succeeded",
            },
            {
              id: "turn-2",
              text: "System reply",
              source: "system",
              startMs: 3000,
              endMs: 4000,
              turnIndex: 1,
              status: "succeeded",
            },
          ],
        })}
      />,
    );

    const renderedTurns = Array.from(
      container.querySelectorAll(".transcript-turn-text"),
    ).map((turn) => turn.textContent);
    expect(renderedTurns).toEqual([
      "First microphone turn",
      "System reply",
      "Second microphone turn",
    ]);
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

  it("renders exhausted invalid service responses as transcript gaps", () => {
    render(
      <NoteEditor
        {...props}
        note={note({
          activeTab: "transcription",
          sourceTranscripts: [
            {
              id: "turn-1",
              text: "Usable transcript text",
              source: "microphone",
              startMs: 1000,
              endMs: 14_000,
              turnIndex: 0,
              status: "succeeded",
            },
            {
              id: "turn-2",
              text: "",
              source: "system",
              startMs: 15_000,
              endMs: 18_000,
              turnIndex: 1,
              status: "failed",
              lastError: "june_api_response_invalid",
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Usable transcript text")).toBeInTheDocument();
    expect(
      screen.getByText("Audio for this part could not be transcribed."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/processing service returned an invalid response/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/june_api_response_invalid/i),
    ).not.toBeInTheDocument();
    expect(screen.getByText("0:15-0:18")).toBeInTheDocument();
  });

  it("renders whole-note source failures as transcript evidence", () => {
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

    expect(
      screen.getByText(
        "Microphone: No speech detected. Try speaking louder or moving closer to the microphone.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("0:15-0:18")).toBeInTheDocument();
    expect(
      screen.getByText(
        "No speech detected. Try speaking louder or moving closer to the microphone.",
      ),
    ).toBeInTheDocument();
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
    expect(screen.getByText("Transcribing audio")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });

  it("shows validating progress in the notes tab", () => {
    render(
      <NoteEditor
        {...props}
        note={note({
          processingStatus: "validating",
          activeTab: "notes",
        })}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Preparing audio");
    expect(screen.getByRole("status")).toHaveAttribute(
      "data-status",
      "validating",
    );
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
    expect(status).toHaveAttribute("data-status", "generating");
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
    expect(screen.getByText(/recording was interrupted/i)).toBeInTheDocument();

    const recordButton = screen.getByRole("button", { name: "Record" });
    expect(recordButton).toBeEnabled();

    await user.click(recordButton);

    // The click records straight away — no blocking dialog in the way.
    expect(onStartRecording).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("status", { name: "Recording consent reminder" }),
    ).not.toBeInTheDocument();
  });

  it("changes the note recording source mode from recording options", async () => {
    const user = userEvent.setup();
    const onSourceModeChange = vi.fn();
    render(
      <NoteEditor
        {...props}
        note={note()}
        sourceMode="microphonePlusSystem"
        onSourceModeChange={onSourceModeChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Recording options" }));
    await user.click(
      screen.getByRole("switch", { name: "Capture system audio" }),
    );

    expect(onSourceModeChange).toHaveBeenCalledWith("microphoneOnly");
  });

  it("routes denied system audio setup from recording options", async () => {
    const user = userEvent.setup();
    const onEnableSystemAudio = vi.fn();
    render(
      <NoteEditor
        {...props}
        note={note()}
        sourceMode="microphonePlusSystem"
        onEnableSystemAudio={onEnableSystemAudio}
        sourceReadiness={{
          sourceMode: "microphonePlusSystem",
          ready: false,
          checkedAt: now,
          sources: [
            {
              source: "microphone",
              required: true,
              ready: true,
              permissionState: "granted",
              deviceAvailable: true,
              captureAvailable: true,
            },
            {
              source: "system",
              required: true,
              ready: false,
              permissionState: "denied",
              deviceAvailable: true,
              captureAvailable: false,
              recoveryAction: "openSystemAudioSettings",
            },
          ],
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Recording options" }));
    const systemSwitch = screen.getByRole("switch", {
      name: "Capture system audio",
    });
    expect(systemSwitch).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Enable" }));
    expect(onEnableSystemAudio).toHaveBeenCalledOnce();
  });

  it("hides system audio recording options on Windows", () => {
    const restoreNavigator = stubNavigatorPlatform(
      "Win32",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    try {
      render(
        <NoteEditor
          {...props}
          note={note()}
          sourceReadiness={{
            sourceMode: "microphonePlusSystem",
            ready: false,
            checkedAt: now,
            sources: [
              {
                source: "microphone",
                required: true,
                ready: true,
                permissionState: "granted",
                deviceAvailable: true,
                captureAvailable: true,
              },
              {
                source: "system",
                required: true,
                ready: false,
                permissionState: "unsupported",
                deviceAvailable: false,
                captureAvailable: false,
              },
            ],
          }}
        />,
      );

      expect(screen.getByRole("button", { name: "Record" })).toBeEnabled();
      expect(
        screen.queryByRole("button", { name: "Recording options" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Capture system audio"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("System audio requires macOS 14.2 or later."),
      ).not.toBeInTheDocument();
    } finally {
      restoreNavigator();
    }
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

  it.each(["transcribing", "generating"] as const)(
    "shows the processing badge and no skeleton while %s",
    (processingStatus) => {
      const { container } = render(
        <NoteEditor
          {...props}
          note={note({ processingStatus, activeTab: "notes" })}
        />,
      );

      expect(container.querySelector(".note-skeleton")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toBeInTheDocument();
    },
  );

  it("wipes the notes in when generation finishes for the open note", () => {
    const { container, rerender } = render(
      <NoteEditor
        {...props}
        note={note({ processingStatus: "generating", activeTab: "notes" })}
      />,
    );

    expect(
      container.querySelector(".note-reveal-active"),
    ).not.toBeInTheDocument();

    rerender(
      <NoteEditor
        {...props}
        note={note({
          processingStatus: "ready",
          generatedContent: "Final notes",
          activeTab: "notes",
        })}
      />,
    );

    expect(container.querySelector(".note-reveal-active")).toBeInTheDocument();
  });

  it("does not wipe when opening an already-finished note", () => {
    const { container } = render(
      <NoteEditor
        {...props}
        note={note({
          processingStatus: "ready",
          generatedContent: "Final notes",
          activeTab: "notes",
        })}
      />,
    );

    expect(
      container.querySelector(".note-reveal-active"),
    ).not.toBeInTheDocument();
  });
});
