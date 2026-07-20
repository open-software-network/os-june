import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportClaudeProjectsDialog } from "../components/folders/ImportClaudeProjectsDialog";
import { discoverClaudeProjects, importClaudeProjects, type FolderDto } from "../lib/tauri";

vi.mock("../lib/tauri", () => ({
  discoverClaudeProjects: vi.fn(),
  importClaudeProjects: vi.fn(),
}));

const importedFolder: FolderDto = {
  id: "folder-1",
  name: "alpha",
  memoryDisabled: false,
  localPath: "/Users/alex/code/alpha",
  createdAt: "2026-07-20T12:00:00Z",
  updatedAt: "2026-07-20T12:00:00Z",
};

describe("ImportClaudeProjectsDialog", () => {
  beforeEach(() => {
    vi.mocked(discoverClaudeProjects).mockReset();
    vi.mocked(importClaudeProjects).mockReset();
  });

  it("preselects every available Claude Code project and imports the selection", async () => {
    vi.mocked(discoverClaudeProjects).mockResolvedValue([
      {
        name: "alpha",
        path: "/Users/alex/code/alpha",
        lastUsedAt: "2026-07-20T12:00:00Z",
        alreadyAdded: false,
      },
      {
        name: "beta",
        path: "/Users/alex/code/beta",
        alreadyAdded: false,
      },
      {
        name: "existing",
        path: "/Users/alex/code/existing",
        alreadyAdded: true,
      },
    ]);
    vi.mocked(importClaudeProjects).mockResolvedValue([importedFolder]);
    const onClose = vi.fn();
    const onImported = vi.fn();

    render(<ImportClaudeProjectsDialog open onClose={onClose} onImported={onImported} />);

    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.queryByText("existing")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add 2 projects" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Add 2 projects" }));
    await waitFor(() =>
      expect(importClaudeProjects).toHaveBeenCalledWith([
        "/Users/alex/code/alpha",
        "/Users/alex/code/beta",
      ]),
    );
    expect(onImported).toHaveBeenCalledWith([importedFolder]);
    expect(onClose).toHaveBeenCalled();
  });

  it("lets the user review and clear the default selection", async () => {
    vi.mocked(discoverClaudeProjects).mockResolvedValue([
      { name: "alpha", path: "/Users/alex/code/alpha", alreadyAdded: false },
    ]);

    render(<ImportClaudeProjectsDialog open onClose={vi.fn()} onImported={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Add 1 project" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByRole("button", { name: "Add 0 projects" })).toBeDisabled();
  });

  it("shows a calm completed state when every discovered folder is linked", async () => {
    vi.mocked(discoverClaudeProjects).mockResolvedValue([
      { name: "alpha", path: "/Users/alex/code/alpha", alreadyAdded: true },
    ]);

    render(<ImportClaudeProjectsDialog open onClose={vi.fn()} onImported={vi.fn()} />);

    expect(await screen.findByText("Everything is already here")).toBeInTheDocument();
    expect(screen.getByText(/All available Claude Code projects/)).toBeInTheDocument();
  });
});
