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
    const onCreateNote = vi.fn();
    render(
      <Sidebar
        folders={folders}
        notes={notes}
        selectedNoteId="note-2"
        selectedFolderId={undefined}
        activeView="notes"
        onChangeView={vi.fn()}
        onCreateFolder={vi.fn()}
        onCreateNote={onCreateNote}
        onSelectAll={vi.fn()}
        onSelectFolder={vi.fn()}
        onSelectNote={onSelectNote}
        onDeleteNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onRemoveNoteFromFolder={vi.fn()}
      />,
    );

    expect(screen.getByText("Scribe")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Search"), "second");
    await user.click(screen.getAllByRole("button", { name: /Second/ })[0]);

    await user.click(screen.getByRole("button", { name: "New note" }));

    expect(onSelectNote).toHaveBeenCalledWith("note-2");
    expect(onCreateNote).toHaveBeenCalled();
  });

  it("opens the all-notes view from the Notes header actions", async () => {
    const user = userEvent.setup();
    const onChangeView = vi.fn();
    render(
      <Sidebar
        folders={folders}
        notes={notes}
        selectedNoteId="note-2"
        selectedFolderId={undefined}
        activeView="notes"
        onChangeView={onChangeView}
        onCreateFolder={vi.fn()}
        onCreateNote={vi.fn()}
        onSelectAll={vi.fn()}
        onSelectFolder={vi.fn()}
        onSelectNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onRemoveNoteFromFolder={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^Notes/ }));
    await user.click(screen.getByRole("button", { name: "View all" }));

    expect(onChangeView).toHaveBeenCalledWith("all-notes");
    expect(onChangeView).toHaveBeenCalledTimes(2);
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
        onOpenMoveDialog={vi.fn()}
        onRemoveNoteFromFolder={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Second").closest("article")!);
    await user.click(screen.getByRole("menuitem", { name: "Delete note" }));

    expect(onDeleteNote).toHaveBeenCalledWith("note-2");
  });

  it("shows notes with placeholders and selects notes", async () => {
    const user = userEvent.setup();
    const onSelectNote = vi.fn();
    const { container } = render(
      <NotesList
        notes={notes}
        selectedNoteId="note-2"
        onSelectNote={onSelectNote}
        onCreateNote={vi.fn()}
      />,
    );
    const list = within(
      container.querySelector(".all-notes-list") as HTMLElement,
    );

    expect(list.getByRole("button", { name: /Second/ })).toBeInTheDocument();
    expect(screen.queryByText("Ideas")).not.toBeInTheDocument();

    await user.click(list.getByRole("button", { name: /Second/ }));
    expect(onSelectNote).toHaveBeenCalledWith("note-2");
  });

  it("labels future-dated notes explicitly", () => {
    render(
      <NotesList
        notes={[
          {
            ...notes[0],
            id: "future-note",
            updatedAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          },
        ]}
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
      />,
    );

    expect(screen.getByText("Future")).toBeInTheDocument();
  });

  it("shows empty state with create action", () => {
    render(
      <NotesList notes={[]} onSelectNote={vi.fn()} onCreateNote={vi.fn()} />,
    );

    expect(screen.getByText("No notes yet.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create your first note" }),
    ).toBeInTheDocument();
  });
});
