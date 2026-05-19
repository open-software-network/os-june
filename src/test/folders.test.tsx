import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NotesList } from "../components/notes-list/NotesList";
import { Sidebar } from "../components/sidebar/Sidebar";
import type { FolderDto, NoteListItemDto } from "../lib/tauri";

const now = "2026-05-19T10:00:00Z";

const folders: FolderDto[] = [
  { id: "folder-1", name: "Ideas", createdAt: now, updatedAt: now },
  { id: "folder-2", name: "Work", createdAt: now, updatedAt: now },
];

const notes: NoteListItemDto[] = [
  {
    id: "note-2",
    title: "Second",
    preview: "Second preview",
    processingStatus: "ready",
    folderIds: ["folder-1"],
    createdAt: "2026-05-19T11:00:00Z",
    updatedAt: "2026-05-19T11:00:00Z",
  },
  {
    id: "note-1",
    title: "",
    preview: "",
    processingStatus: "draft",
    folderIds: [],
    createdAt: now,
    updatedAt: now,
  },
];

describe("folders UI", () => {
  it("renders required sidebar items and selects folders", async () => {
    const user = userEvent.setup();
    const onSelectFolder = vi.fn();
    render(
      <Sidebar
        folders={folders}
        selectedFolderId={undefined}
        onCreateFolder={vi.fn()}
        onSelectAll={vi.fn()}
        onSelectFolder={onSelectFolder}
      />,
    );

    expect(screen.getByText("OS Notetaker")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "+ New Folder" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "All Notes" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ideas" }));

    expect(onSelectFolder).toHaveBeenCalledWith("folder-1");
  });

  it("shows notes with placeholders and empty folder action", () => {
    const { container } = render(
      <NotesList
        notes={notes}
        selectedNoteId="note-2"
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
      />,
    );
    const list = within(container.querySelector(".notes-list") as HTMLElement);

    expect(list.getByRole("button", { name: /Second/ })).toBeInTheDocument();
    expect(
      list.getAllByRole("button", { name: /New note/ }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("shows empty state with create action", () => {
    render(
      <NotesList notes={[]} onSelectNote={vi.fn()} onCreateNote={vi.fn()} />,
    );

    expect(screen.getByText("No notes yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New note" }),
    ).toBeInTheDocument();
  });
});
