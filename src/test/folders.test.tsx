import { fireEvent, render, screen, within } from "@testing-library/react";
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
  it("renders notes in the sidebar and filters them", async () => {
    const user = userEvent.setup();
    const onSelectNote = vi.fn();
    render(
      <Sidebar
        folders={folders}
        notes={notes}
        selectedNoteId="note-2"
        selectedFolderId={undefined}
        activeView="notes"
        onChangeView={vi.fn()}
        onCreateFolder={vi.fn()}
        onCreateNote={vi.fn()}
        onSelectAll={vi.fn()}
        onSelectFolder={vi.fn()}
        onSelectNote={onSelectNote}
        onDeleteNote={vi.fn()}
      />,
    );

    expect(screen.getByText("Scribe")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Jump to…"), "second");
    await user.click(screen.getAllByRole("button", { name: /Second/ })[0]);

    expect(screen.queryByText("New note")).not.toBeInTheDocument();
    expect(onSelectNote).toHaveBeenCalledWith("note-2");
  });

  it("opens note actions from right click and deletes", async () => {
    const user = userEvent.setup();
    const onDeleteNote = vi.fn();
    render(
      <Sidebar
        folders={folders}
        notes={notes}
        selectedNoteId="note-2"
        selectedFolderId={undefined}
        activeView="notes"
        onChangeView={vi.fn()}
        onCreateFolder={vi.fn()}
        onCreateNote={vi.fn()}
        onSelectAll={vi.fn()}
        onSelectFolder={vi.fn()}
        onSelectNote={vi.fn()}
        onDeleteNote={onDeleteNote}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Second").closest("article")!);
    await user.click(screen.getByRole("menuitem", { name: "Delete note" }));

    expect(onDeleteNote).toHaveBeenCalledWith("note-2");
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
