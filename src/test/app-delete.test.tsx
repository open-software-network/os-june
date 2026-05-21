import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import * as tauri from "../lib/tauri";
import type {
  BootstrapResponse,
  RecordingSourceReadinessDto,
} from "../lib/tauri";

vi.mock("../lib/tauri", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/tauri")>("../lib/tauri");
  return {
    ...actual,
    bootstrapApp: vi.fn(),
    checkRecordingSourceReadiness: vi.fn(),
    deleteFolder: vi.fn(),
    deleteNote: vi.fn(),
    listNotes: vi.fn(),
  };
});

const now = "2026-05-19T10:00:00Z";

const bootstrap: BootstrapResponse = {
  folders: [{ id: "folder-1", name: "Work", createdAt: now, updatedAt: now }],
  notes: [
    {
      id: "note-1",
      title: "Second",
      preview: "Second preview",
      processingStatus: "ready",
      folderIds: ["folder-1"],
      createdAt: now,
      updatedAt: now,
    },
  ],
  activeRecoveries: [],
  providerConfigured: true,
};

const readiness: RecordingSourceReadinessDto = {
  sourceMode: "microphoneOnly",
  ready: true,
  sources: [
    {
      source: "microphone",
      required: true,
      ready: true,
      permissionState: "granted",
      deviceAvailable: true,
      captureAvailable: true,
    },
  ],
};

describe("App delete confirmations", () => {
  beforeEach(() => {
    vi.mocked(tauri.bootstrapApp).mockResolvedValue(bootstrap);
    vi.mocked(tauri.checkRecordingSourceReadiness).mockResolvedValue(readiness);
    vi.mocked(tauri.deleteFolder).mockResolvedValue();
    vi.mocked(tauri.deleteNote).mockResolvedValue();
    vi.mocked(tauri.listNotes).mockResolvedValue({
      items: [],
      nextCursor: undefined,
    });
  });

  it("shows an in-app confirmation before deleting a note", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("button", { name: "Delete note Second" });
    await user.click(
      screen.getByRole("button", { name: "Delete note Second" }),
    );

    expect(screen.getByRole("dialog")).toHaveTextContent('Delete "Second"?');
    expect(tauri.deleteNote).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete note" }));

    await waitFor(() =>
      expect(tauri.deleteNote).toHaveBeenCalledWith("note-1"),
    );
  });

  it("asks whether folder notes should also be deleted", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("button", { name: "Delete folder Work" });
    await user.click(
      screen.getByRole("button", { name: "Delete folder Work" }),
    );

    expect(screen.getByRole("dialog")).toHaveTextContent(
      'Delete folder "Work"?',
    );

    await user.click(screen.getByRole("button", { name: "Delete notes too" }));

    await waitFor(() =>
      expect(tauri.deleteFolder).toHaveBeenCalledWith("folder-1", true),
    );
  });
});
