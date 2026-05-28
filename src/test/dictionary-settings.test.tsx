import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DictionarySettingsSection } from "../components/settings/DictionarySettingsSection";

const mocks = vi.hoisted(() => ({
  listDictionaryEntries: vi.fn(),
  createDictionaryEntry: vi.fn(),
  updateDictionaryEntry: vi.fn(),
  deleteDictionaryEntry: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  listDictionaryEntries: mocks.listDictionaryEntries,
  createDictionaryEntry: mocks.createDictionaryEntry,
  updateDictionaryEntry: mocks.updateDictionaryEntry,
  deleteDictionaryEntry: mocks.deleteDictionaryEntry,
}));

const now = "2026-05-26T00:00:00Z";

describe("DictionarySettingsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listDictionaryEntries.mockResolvedValue([
      {
        id: "entry-1",
        phrase: "Junho Hong",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    mocks.createDictionaryEntry.mockImplementation(async (input) => ({
      id: "entry-2",
      ...input,
      createdAt: now,
      updatedAt: now,
    }));
    mocks.updateDictionaryEntry.mockImplementation(async (input) => ({
      id: input.entryId,
      phrase: input.phrase,
      createdAt: now,
      updatedAt: now,
    }));
    mocks.deleteDictionaryEntry.mockResolvedValue(undefined);
  });

  it("loads, creates, edits, and deletes dictionary entries", async () => {
    const user = userEvent.setup();
    render(<DictionarySettingsSection />);

    expect(await screen.findByText("Junho Hong")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add entry" }));
    const addDialog = screen.getByRole("dialog", {
      name: "Add dictionary entry",
    });
    await user.type(within(addDialog).getByLabelText("Word or phrase"), "OSS");
    await user.click(
      within(addDialog).getByRole("button", { name: "Add entry" }),
    );

    expect(mocks.createDictionaryEntry).toHaveBeenCalledWith({
      phrase: "OSS",
    });
    expect(await screen.findByText("OSS")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit OSS" }));
    const editDialog = screen.getByRole("dialog", {
      name: "Edit dictionary entry",
    });
    await user.clear(within(editDialog).getByLabelText("Word or phrase"));
    await user.type(
      within(editDialog).getByLabelText("Word or phrase"),
      "Open Source Software",
    );
    await user.click(
      within(editDialog).getByRole("button", { name: "Save changes" }),
    );

    expect(mocks.updateDictionaryEntry).toHaveBeenCalledWith({
      entryId: "entry-2",
      phrase: "Open Source Software",
    });

    await user.click(
      screen.getByRole("button", { name: "Delete Open Source Software" }),
    );
    await waitFor(() =>
      expect(mocks.deleteDictionaryEntry).toHaveBeenCalledWith("entry-2"),
    );
  });

  it("renders an empty state when there are no entries", async () => {
    mocks.listDictionaryEntries.mockResolvedValueOnce([]);
    render(<DictionarySettingsSection />);
    expect(await screen.findByText(/no entries yet/i)).toBeInTheDocument();
  });
});
