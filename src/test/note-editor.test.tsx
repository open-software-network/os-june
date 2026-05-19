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
    generatedContent: "Generated body",
    activeTab: "notes",
    ...overrides,
  };
}

const props = {
  folders: [],
  onTitleChange: vi.fn(),
  onContentChange: vi.fn(),
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
  it("edits title and generated note body", async () => {
    const user = userEvent.setup();
    const onTitleChange = vi.fn();
    const onContentChange = vi.fn();
    render(
      <NoteEditor
        {...props}
        note={note()}
        onTitleChange={onTitleChange}
        onContentChange={onContentChange}
      />,
    );

    await user.type(screen.getByLabelText("Note title"), " updated");
    await user.type(screen.getByLabelText("Generated note"), " extra");

    expect(onTitleChange).toHaveBeenCalled();
    expect(onContentChange).toHaveBeenCalled();
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

  it("requests tab change when Transcription is selected", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(<NoteEditor {...props} note={note()} onTabChange={onTabChange} />);

    await user.click(screen.getByRole("tab", { name: "Transcription" }));

    expect(onTabChange).toHaveBeenCalledWith("transcription");
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
          lastError: "Transcription failed",
          audio: {
            id: "audio-1",
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
});
