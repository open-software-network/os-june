import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FoldersWorkspace } from "../components/folders/FoldersWorkspace";
import { Sidebar } from "../components/sidebar/Sidebar";
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
    onDeleteNote: vi.fn(),
  };
}

describe("Sidebar — Folders nav item", () => {
  it("activates the folders view when clicked", async () => {
    const user = userEvent.setup();
    const onChangeView = vi.fn();
    render(
      <Sidebar
        folders={folders}
        notes={notes}
        selectedNoteId={undefined}
        selectedFolderId={undefined}
        activeView="notes"
        onChangeView={onChangeView}
        onCreateFolder={vi.fn()}
        onCreateNote={vi.fn()}
        onSelectAll={vi.fn()}
        onSelectFolder={vi.fn()}
        onSelectNote={vi.fn()}
        onDeleteNote={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Folders/ }));
    expect(onChangeView).toHaveBeenCalledWith("folders");
  });

  it("does not render the folder count badge", () => {
    render(
      <Sidebar
        folders={folders}
        notes={notes}
        selectedNoteId={undefined}
        selectedFolderId={undefined}
        activeView="notes"
        onChangeView={vi.fn()}
        onCreateFolder={vi.fn()}
        onCreateNote={vi.fn()}
        onSelectAll={vi.fn()}
        onSelectFolder={vi.fn()}
        onSelectNote={vi.fn()}
        onDeleteNote={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: /Folders/ });
    expect(button.textContent?.replace(/\s/g, "")).toBe("Folders");
  });
});

describe("FoldersWorkspace — list view", () => {
  it("renders folder cards with descriptions or note counts and no All notes", () => {
    render(<FoldersWorkspace {...baseProps()} />);

    expect(
      screen.getByRole("heading", { name: "Folders" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("All notes")).toBeNull();
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
});

describe("FoldersWorkspace — detail view", () => {
  it("renders the folder via sticky header and surfaces description + meta", () => {
    render(<FoldersWorkspace {...baseProps()} selectedFolderId="folder-2" />);

    // Folder name shows in the breadcrumb and as the editable title.
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

    await user.click(screen.getByRole("button", { name: /^Folders$/ }));
    expect(props.onSelectFolder).toHaveBeenCalledWith(undefined);
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
