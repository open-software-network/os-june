import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FoldersWorkspace } from "../components/folders/FoldersWorkspace";
import { Sidebar } from "../components/sidebar/Sidebar";
import { NOTE_DND_MIME } from "../lib/dnd";
import type { FolderDto, NoteListItemDto } from "../lib/tauri";

const now = "2026-05-19T10:00:00Z";

const folders: FolderDto[] = [
  { id: "folder-1", name: "Ideas", createdAt: now, updatedAt: now },
  {
    id: "folder-2",
    name: "Work",
    description: "Client projects in flight",
    createdAt: now,
    updatedAt: now,
  },
];

const notes: NoteListItemDto[] = [
  {
    id: "note-1",
    title: "Roadmap",
    preview: "Q3 priorities",
    processingStatus: "ready",
    folderIds: ["folder-2"],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "note-2",
    title: "Loose thought",
    preview: "",
    processingStatus: "draft",
    folderIds: [],
    createdAt: now,
    updatedAt: now,
  },
];

function baseProps() {
  return {
    folders,
    notes,
    selectedFolderId: undefined as string | undefined,
    onSelectFolder: vi.fn(),
    onCreateFolder: vi.fn(),
    onRenameFolder: vi.fn(),
    onDeleteFolder: vi.fn(),
    onCreateNote: vi.fn(),
    onSelectNote: vi.fn(),
    onAssignNoteToFolder: vi.fn(async () => undefined),
    onRemoveNoteFromFolder: vi.fn(),
    onOpenMoveDialog: vi.fn(),
    onDeleteNote: vi.fn(),
  };
}

describe("Sidebar primary navigation", () => {
  it("shows Notes instead of Folders in primary navigation", async () => {
    const user = userEvent.setup();
    const onChangeView = vi.fn();
    render(
      <Sidebar
        notes={notes}
        activeView="notes"
        onChangeView={onChangeView}
        onSelectNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onRemoveNoteFromFolder={vi.fn()}
        onNewAgentSession={vi.fn()}
        onSelectAgentSession={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /Folders/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Notes" }));
    expect(onChangeView).toHaveBeenCalledWith("notes");
  });

  it("renders settings as a sidebar footer action", async () => {
    const user = userEvent.setup();
    const onChangeView = vi.fn();
    render(
      <Sidebar
        notes={notes}
        activeView="notes"
        onChangeView={onChangeView}
        onSelectNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onRemoveNoteFromFolder={vi.fn()}
        onNewAgentSession={vi.fn()}
        onSelectAgentSession={vi.fn()}
      />,
    );

    // The settings entry point is the user's name in the footer: click it to
    // open the account popover, then choose Settings.
    const identityButton = screen.getByRole("button", {
      name: /account menu/i,
    });
    expect(identityButton.closest(".sidebar-footer")).not.toBeNull();

    await user.click(identityButton);
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(onChangeView).toHaveBeenCalledWith("settings");
  });

  it("opens dictation history from the primary nav", async () => {
    const user = userEvent.setup();
    const onChangeView = vi.fn();
    render(
      <Sidebar
        notes={notes}
        activeView="notes"
        onChangeView={onChangeView}
        onSelectNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onRemoveNoteFromFolder={vi.fn()}
        onNewAgentSession={vi.fn()}
        onSelectAgentSession={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Dictation" }));
    expect(onChangeView).toHaveBeenCalledWith("dictation");
  });
});

describe("FoldersWorkspace — list view", () => {
  it("renders folder cards with descriptions or note counts and no All notes", () => {
    render(<FoldersWorkspace {...baseProps()} />);

    expect(
      screen.getByRole("heading", { name: "Folders" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("All notes")).toBeNull();
    expect(screen.getByRole("button", { name: /Notes/ })).toBeInTheDocument();
    expect(screen.queryByText("Roadmap")).toBeNull();
    expect(screen.getByText("Ideas")).toBeInTheDocument();
    expect(screen.getByText("Work")).toBeInTheDocument();
    const workCard = screen.getByText("Work").closest("article");
    expect(workCard).not.toBeNull();
    // Description preferred over note count when present.
    expect(
      within(workCard as HTMLElement).getByText("Client projects in flight"),
    ).toBeInTheDocument();
    const ideasCard = screen.getByText("Ideas").closest("article");
    expect(
      within(ideasCard as HTMLElement).getByText(/0 notes/),
    ).toBeInTheDocument();
  });

  it("opens the notes folder before showing saved notes", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<FoldersWorkspace {...props} />);

    await user.click(screen.getByRole("button", { name: /Notes/ }));

    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
    expect(screen.getByText("Roadmap")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Roadmap/ }));
    expect(props.onSelectNote).toHaveBeenCalledWith("note-1");
  });

  it("opens the create dialog and submits name + description", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<FoldersWorkspace {...props} />);

    await user.click(screen.getByRole("button", { name: /New folder/ }));
    expect(
      screen.getByRole("dialog", { name: /Create folder/ }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Name"), "Personal");
    await user.type(screen.getByLabelText("Description"), "Side projects");
    await user.click(screen.getByRole("button", { name: /Create folder/ }));

    expect(props.onCreateFolder).toHaveBeenCalledWith(
      "Personal",
      "Side projects",
    );
  });

  it("filters folders by search query", async () => {
    const user = userEvent.setup();
    render(<FoldersWorkspace {...baseProps()} />);

    await user.type(screen.getByPlaceholderText("Search"), "work");
    expect(screen.queryByText("Ideas")).toBeNull();
    expect(screen.getByText("Work")).toBeInTheDocument();
  });

  it("opens a folder when its card is clicked", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<FoldersWorkspace {...props} />);

    const ideasCard = screen.getByText("Ideas").closest("article");
    await user.click(within(ideasCard as HTMLElement).getByText("Ideas"));
    expect(props.onSelectFolder).toHaveBeenCalledWith("folder-1");
  });

  it("normalizes legacy multi-folder notes when dropped on an assigned folder", () => {
    const props = baseProps();
    render(
      <FoldersWorkspace
        {...props}
        notes={[{ ...notes[0], folderIds: ["folder-1", "folder-2"] }]}
      />,
    );

    fireEvent.drop(screen.getByRole("button", { name: "Open Ideas" }), {
      dataTransfer: {
        types: [NOTE_DND_MIME],
        getData: () => "note-1",
      },
    });

    expect(props.onAssignNoteToFolder).toHaveBeenCalledWith(
      "note-1",
      "folder-1",
    );
  });

  it("clears drop highlight when a drag is cancelled", async () => {
    render(<FoldersWorkspace {...baseProps()} />);
    const card = screen.getByRole("button", { name: "Open Ideas" });

    fireEvent.dragEnter(card, {
      dataTransfer: {
        types: [NOTE_DND_MIME],
      },
    });
    expect(card).toHaveAttribute("data-drop-active", "true");

    fireEvent.dragEnd(document);

    await waitFor(() => expect(card).not.toHaveAttribute("data-drop-active"));
  });

  it("keeps delete confirmation open until async delete resolves", async () => {
    const user = userEvent.setup();
    let resolveDelete: (() => void) | undefined;
    const props = {
      ...baseProps(),
      onDeleteFolder: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveDelete = resolve;
          }),
      ),
    };
    render(<FoldersWorkspace {...props} />);

    await user.click(screen.getByRole("button", { name: /Actions for Ideas/ }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete folder" }));

    expect(
      screen.getByRole("dialog", { name: /Delete "Ideas"/ }),
    ).toBeInTheDocument();

    resolveDelete?.();

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /Delete "Ideas"/ }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps delete confirmation open when async delete fails", async () => {
    const user = userEvent.setup();
    const props = {
      ...baseProps(),
      onDeleteFolder: vi.fn(() => Promise.reject(new Error("Nope"))),
    };
    render(<FoldersWorkspace {...props} />);

    await user.click(screen.getByRole("button", { name: /Actions for Ideas/ }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete folder" }));

    expect(
      screen.getByRole("dialog", { name: /Delete "Ideas"/ }),
    ).toBeInTheDocument();
  });
});

describe("FoldersWorkspace — detail view", () => {
  it("renders the folder via sticky header and surfaces description + meta", () => {
    render(<FoldersWorkspace {...baseProps()} selectedFolderId="folder-2" />);

    // Folder name shows as the editable title.
    expect(
      screen.getByRole("button", { name: /Rename folder/ }),
    ).toHaveTextContent("Work");
    expect(screen.getByText("Client projects in flight")).toBeInTheDocument();
    expect(screen.getByText("Roadmap")).toBeInTheDocument();
  });

  it("enters edit mode on a single click of the title", async () => {
    const user = userEvent.setup();
    render(<FoldersWorkspace {...baseProps()} selectedFolderId="folder-1" />);

    await user.click(screen.getByRole("button", { name: /Rename folder/ }));
    // The serif title is replaced by an input that auto-selects its value.
    expect(document.activeElement).toBeInstanceOf(HTMLInputElement);
    expect((document.activeElement as HTMLInputElement).value).toBe("Ideas");
  });

  it("returns to the list via the back button in the sticky bar", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<FoldersWorkspace {...props} selectedFolderId="folder-1" />);

    await user.click(screen.getByRole("button", { name: /back to folders/i }));
    expect(props.onSelectFolder).toHaveBeenCalledWith(undefined);
  });

  it("returns to the provided source when opened from a note", async () => {
    const user = userEvent.setup();
    const props = {
      ...baseProps(),
      folderBackTarget: {
        label: "Back to Test",
        onBack: vi.fn(),
      },
    };
    render(<FoldersWorkspace {...props} selectedFolderId="folder-1" />);

    await user.click(screen.getByRole("button", { name: /back to test/i }));
    expect(props.folderBackTarget.onBack).toHaveBeenCalled();
    expect(props.onSelectFolder).not.toHaveBeenCalled();
  });

  it("renders empty-state actions and triggers create-note", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<FoldersWorkspace {...props} selectedFolderId="folder-1" />);

    // The empty surface is visual-only — no helper text — just the
    // primary action and "Add existing note" when other notes exist.
    await user.click(screen.getByRole("button", { name: /^New note$/ }));
    expect(props.onCreateNote).toHaveBeenCalledWith("folder-1");
  });

  it("removes a note from the folder via its row overflow menu", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<FoldersWorkspace {...props} selectedFolderId="folder-2" />);

    await user.click(
      screen.getByRole("button", { name: /Actions for Roadmap/ }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: /Remove from folder/ }),
    );
    expect(props.onRemoveNoteFromFolder).toHaveBeenCalledWith(
      "note-1",
      "folder-2",
    );
  });
});
