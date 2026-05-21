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
        onDeleteFolder={vi.fn()}
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

  it("creates folders from the sidebar form", async () => {
    const user = userEvent.setup();
    const onCreateFolder = vi.fn();
    render(
      <Sidebar
        folders={folders}
        selectedFolderId={undefined}
        onCreateFolder={onCreateFolder}
        onDeleteFolder={vi.fn()}
        onSelectAll={vi.fn()}
        onSelectFolder={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "+ New Folder" }));
    await user.type(screen.getByLabelText("Folder name"), "Research");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(onCreateFolder).toHaveBeenCalledWith("Research");
  });

  it("deletes folders from the sidebar delete action", async () => {
    const user = userEvent.setup();
    const onDeleteFolder = vi.fn();
    render(
      <Sidebar
        folders={folders}
        selectedFolderId={undefined}
        onCreateFolder={vi.fn()}
        onDeleteFolder={onDeleteFolder}
        onSelectAll={vi.fn()}
        onSelectFolder={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete folder Ideas" }),
    );

    expect(onDeleteFolder).toHaveBeenCalledWith(folders[0]);
  });

  it("shows notes with placeholders and delete actions", async () => {
    const user = userEvent.setup();
    const onDeleteNote = vi.fn();
    const { container } = render(
      <NotesList
        notes={notes}
        selectedNoteId="note-2"
        onSelectNote={vi.fn()}
        onDeleteNote={onDeleteNote}
        onCreateNote={vi.fn()}
      />,
    );
    const list = within(container.querySelector(".notes-list") as HTMLElement);

    expect(
      list.getByRole("button", { name: "Second Second preview" }),
    ).toBeInTheDocument();
    expect(
      list.getAllByRole("button", { name: /New note/ }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      list.getByRole("button", { name: "Delete note Second" }),
    ).toBeInTheDocument();

    await user.click(list.getByRole("button", { name: "Delete note Second" }));

    expect(onDeleteNote).toHaveBeenCalledWith(notes[0]);
  });

  it("shows empty state with create action", () => {
    render(
      <NotesList
        notes={[]}
        onSelectNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onCreateNote={vi.fn()}
      />,
    );

    expect(screen.getByText("No notes yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New note" }),
    ).toBeInTheDocument();
  });
});
