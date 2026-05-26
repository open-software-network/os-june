import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NoteEditor } from "../components/note-editor/NoteEditor";
import type { FolderDto, NoteDto } from "../lib/tauri";

const now = "2026-05-19T10:00:00Z";

function note(): NoteDto {
  return {
    id: "note-1",
    title: "Untitled",
    preview: "",
    processingStatus: "ready",
    folderIds: [],
    createdAt: now,
    updatedAt: now,
    activeTab: "notes",
  };
}

function baseProps(folders: FolderDto[]) {
  return {
    note: note(),
    folders,
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
    onCreateAndAssignFolder: vi.fn(),
    onNavigateToFolders: vi.fn(),
    onNavigateToFolder: vi.fn(),
    onTabChange: vi.fn(),
  };
}

describe("Folder chip — move-to-folder popover", () => {
  it("shows 'Folder' label when nothing is assigned", () => {
    render(<NoteEditor {...baseProps([])} />);
    expect(screen.getByRole("button", { name: /^Folder/ })).toBeInTheDocument();
  });

  it("filters folders by the search query", async () => {
    const user = userEvent.setup();
    render(
      <NoteEditor
        {...baseProps([
          { id: "f1", name: "Ideas", createdAt: now, updatedAt: now },
          { id: "f2", name: "Work", createdAt: now, updatedAt: now },
        ])}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^Folder/ }));
    const input = screen.getByPlaceholderText("Search or create folder");
    await user.type(input, "wor");

    expect(screen.queryByText("Ideas")).toBeNull();
    expect(screen.getByText("Work")).toBeInTheDocument();
  });

  it("offers 'Create' when no existing folder matches", async () => {
    const user = userEvent.setup();
    const props = baseProps([
      { id: "f1", name: "Ideas", createdAt: now, updatedAt: now },
    ]);
    render(<NoteEditor {...props} />);

    await user.click(screen.getByRole("button", { name: /^Folder/ }));
    await user.type(
      screen.getByPlaceholderText("Search or create folder"),
      "Personal",
    );

    const create = screen.getByRole("button", { name: /Create.*Personal/ });
    await user.click(create);
    expect(props.onCreateAndAssignFolder).toHaveBeenCalledWith("Personal");
  });
});
