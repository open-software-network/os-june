import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySettingsSection } from "../components/settings/MemorySettingsSection";
import type { FolderDto, MemoryDto } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  listMemories: vi.fn(),
  memorySettings: vi.fn(),
  setMemoryEnabled: vi.fn(),
  createMemory: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
}));

vi.mock("../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauri")>();
  return { ...actual, ...mocks };
});

const stamp = "2026-07-01T00:00:00Z";

const folders: FolderDto[] = [
  { id: "project-a", name: "Alpha", memoryDisabled: false, createdAt: stamp, updatedAt: stamp },
  { id: "project-b", name: "Beta", memoryDisabled: false, createdAt: stamp, updatedAt: stamp },
];

// The manager shows every memory — global and per-project.
const memories: MemoryDto[] = [
  {
    id: "global-user",
    content: "Use concise answers",
    source: "user",
    createdAt: "2026-07-03T00:00:00Z",
    updatedAt: "2026-07-03T00:00:00Z",
  },
  {
    id: "global-agent",
    content: "Prefers metric units",
    source: "agent",
    createdAt: "2026-07-04T00:00:00Z",
    updatedAt: "2026-07-04T00:00:00Z",
  },
  {
    id: "alpha",
    folderId: "project-a",
    content: "Launch day is Friday",
    source: "agent",
    createdAt: "2026-07-05T00:00:00Z",
    updatedAt: "2026-07-05T00:00:00Z",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMemories.mockResolvedValue(memories);
  mocks.memorySettings.mockResolvedValue({ enabled: true });
  mocks.setMemoryEnabled.mockImplementation(async (enabled: boolean) => ({ enabled }));
  mocks.createMemory.mockImplementation(
    async ({ folderId, content }: { folderId?: string; content: string }) => ({
      id: "created",
      folderId,
      content,
      source: "user",
      createdAt: "2026-07-06T00:00:00Z",
      updatedAt: "2026-07-06T00:00:00Z",
    }),
  );
  mocks.updateMemory.mockImplementation(async (id: string, content: string) => {
    const memory = memories.find((candidate) => candidate.id === id);
    if (!memory) throw new Error("Missing test memory");
    return { ...memory, content };
  });
  mocks.deleteMemory.mockResolvedValue(undefined);
});

describe("MemorySettingsSection", () => {
  it("allows the user to add the first memory from the empty state", async () => {
    mocks.listMemories.mockResolvedValueOnce([]);
    const user = userEvent.setup();
    render(<MemorySettingsSection folders={folders} />);

    expect(await screen.findByText("Nothing remembered yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add memory" }));

    const addDialog = screen.getByRole("dialog", { name: "Add memory" });
    await user.type(within(addDialog).getByRole("textbox", { name: "Memory" }), "Call Sam");
    await user.click(within(addDialog).getByRole("button", { name: "Add memory" }));

    await waitFor(() =>
      expect(mocks.createMemory).toHaveBeenCalledWith({
        content: "Call Sam",
        source: "user",
      }),
    );
    expect(await screen.findByText("Call Sam")).toBeInTheDocument();
  });

  it("lists every memory with project tags, sources, and a count", async () => {
    render(<MemorySettingsSection folders={folders} />);

    expect(await screen.findByText("Launch day is Friday")).toBeInTheDocument();
    // Fetches all memories, global and per-project.
    expect(mocks.listMemories).toHaveBeenCalledWith(undefined, true);
    // Total count sits in the section heading pill, matching Agent / Skills.
    const heading = screen.getByRole("heading", { level: 2, name: /Saved memories/ });
    expect(within(heading).getByText("3")).toBeInTheDocument();
    // Project tag only on the scoped memory; un-scoped rows show no chip.
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("General")).toBeNull();
    expect(screen.getByText("Added by you")).toBeInTheDocument();
    expect(screen.getAllByText("Added by June")).toHaveLength(2);
  });

  it("filters the list by search query", async () => {
    const user = userEvent.setup();
    render(<MemorySettingsSection folders={folders} />);
    await screen.findByText("Launch day is Friday");

    await user.type(screen.getByRole("searchbox", { name: "Search memories" }), "metric");
    expect(screen.getByText("Prefers metric units")).toBeInTheDocument();
    expect(screen.queryByText("Launch day is Friday")).toBeNull();
  });

  it("filters the list to a single project", async () => {
    const user = userEvent.setup();
    render(<MemorySettingsSection folders={folders} />);
    await screen.findByText("Launch day is Friday");

    await user.click(screen.getByRole("button", { name: "Filter memories by project" }));
    await user.click(screen.getByRole("option", { name: /Alpha/ }));

    expect(screen.getByText("Launch day is Friday")).toBeInTheDocument();
    expect(screen.queryByText("Use concise answers")).toBeNull();
  });

  it("pre-filters to the project passed as initialFolderFilter", async () => {
    render(<MemorySettingsSection folders={folders} initialFolderFilter="project-a" />);

    expect(await screen.findByText("Launch day is Friday")).toBeInTheDocument();
    expect(screen.queryByText("Use concise answers")).toBeNull();
  });

  it("can change a project-scoped new memory back to General", async () => {
    const user = userEvent.setup();
    render(<MemorySettingsSection folders={folders} initialFolderFilter="project-a" />);
    await screen.findByText("Launch day is Friday");

    await user.click(screen.getByRole("button", { name: "Add memory" }));
    const addDialog = screen.getByRole("dialog", { name: "Add memory" });
    expect(within(addDialog).getByRole("button", { name: "Memory project" })).toHaveTextContent(
      "Alpha",
    );

    await user.click(within(addDialog).getByRole("button", { name: "Memory project" }));
    await user.click(screen.getByRole("option", { name: "General" }));
    await user.type(within(addDialog).getByRole("textbox", { name: "Memory" }), "Call Sam");
    await user.click(within(addDialog).getByRole("button", { name: "Add memory" }));

    await waitFor(() =>
      expect(mocks.createMemory).toHaveBeenCalledWith({
        content: "Call Sam",
        source: "user",
      }),
    );
  });

  it("adds a memory, then edits and deletes through the bindings", async () => {
    const user = userEvent.setup();
    render(<MemorySettingsSection folders={folders} />);
    await screen.findByText("Use concise answers");

    await user.click(screen.getByRole("button", { name: "Add memory" }));
    const addDialog = screen.getByRole("dialog", { name: "Add memory" });
    await user.type(within(addDialog).getByRole("textbox", { name: "Memory" }), "Call Sam");
    await user.click(within(addDialog).getByRole("button", { name: "Add memory" }));
    await waitFor(() =>
      expect(mocks.createMemory).toHaveBeenCalledWith({
        content: "Call Sam",
        source: "user",
      }),
    );

    const conciseRow = screen.getByText("Use concise answers").closest(".memory-row");
    await user.click(
      within(conciseRow as HTMLElement).getByRole("button", { name: "Edit memory" }),
    );
    const editDialog = screen.getByRole("dialog", { name: "Edit memory" });
    const editField = within(editDialog).getByRole("textbox", { name: "Memory" });
    await user.clear(editField);
    await user.type(editField, "Use very concise answers");
    await user.click(within(editDialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(mocks.updateMemory).toHaveBeenCalledWith("global-user", "Use very concise answers"),
    );

    const updatedRow = screen.getByText("Use very concise answers").closest(".memory-row");
    await user.click(
      within(updatedRow as HTMLElement).getByRole("button", { name: "Delete memory" }),
    );
    const deleteDialog = screen.getByRole("dialog", { name: "Delete memory?" });
    await user.click(within(deleteDialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.deleteMemory).toHaveBeenCalledWith("global-user"));
  });

  it("wires the global toggle and keeps saved memories inspectable while off", async () => {
    mocks.memorySettings.mockResolvedValueOnce({ enabled: false });
    const user = userEvent.setup();
    render(<MemorySettingsSection folders={folders} />);

    expect(await screen.findByText("Use concise answers")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add memory" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Edit memory" })[0]).toBeDisabled();
    expect(
      screen.getByText(
        "Memory is off. Saved memories remain visible, but June cannot add or update them.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Let June remember things" }));
    expect(mocks.setMemoryEnabled).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add memory" })).toBeEnabled());
  });
});
