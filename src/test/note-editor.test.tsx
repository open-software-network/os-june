import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NoteEditor } from "../components/note-editor/NoteEditor";
import type { NoteDto } from "../lib/tauri";

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
  onStartRecording: vi.fn(),
  onPauseRecording: vi.fn(),
  onResumeRecording: vi.fn(),
  onFinishRecording: vi.fn(),
  onRetry: vi.fn(),
  onAssignFolder: vi.fn(),
  onRemoveFolder: vi.fn(),
  onTabChange: vi.fn(),
};

describe("NoteEditor", () => {
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

    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText("Microphone")).toBeInTheDocument();
    expect(screen.getByText("0:01-0:03")).toBeInTheDocument();
    expect(screen.getByText("System playback text")).toBeInTheDocument();
    expect(screen.getByText("Microphone response")).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalled();
  });

  it("locks the record button and hides retry while processing", () => {
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

    expect(screen.getByRole("button", { name: "Record" })).toBeDisabled();
    expect(screen.getByText("Transcribing audio...")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
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
});
