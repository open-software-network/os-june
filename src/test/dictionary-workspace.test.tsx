import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DictionaryWorkspace } from "../components/dictionary/DictionaryWorkspace";

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

describe("DictionaryWorkspace", () => {
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
    render(<DictionaryWorkspace />);

    expect(await screen.findByText("Junho Hong")).toBeInTheDocument();
    expect(screen.queryByText(/Sounds like/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Notes")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Word or phrase"), "OSS");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(mocks.createDictionaryEntry).toHaveBeenCalledWith({
      phrase: "OSS",
    });
    expect(await screen.findByText("OSS")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit OSS" }));
    await user.clear(screen.getByLabelText("Word or phrase"));
    await user.type(
      screen.getByLabelText("Word or phrase"),
      "Open Source Software",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

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
});
