import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NoteRecoveryPrompt } from "../components/recorder/NoteRecoveryPrompt";
import type { RecoverableRecordingDto } from "../lib/tauri";

const recovery: RecoverableRecordingDto = {
  sessionId: "session-1",
  noteId: "note-1",
  startedAt: "2026-05-19T10:00:00Z",
  partialPathPresent: true,
  finalPathPresent: false,
  bytesFound: 4096,
};

describe("NoteRecoveryPrompt", () => {
  it("surfaces recoverable recordings with recover and discard actions", async () => {
    const user = userEvent.setup();
    const onRecover = vi.fn();
    const onDiscard = vi.fn();
    render(
      <NoteRecoveryPrompt
        recovery={recovery}
        onRecover={onRecover}
        onDiscard={onDiscard}
      />,
    );

    expect(screen.getByText(/recording was interrupted/i)).toBeInTheDocument();
    expect(screen.getByText(/4\.0 KB/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Recover" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(onRecover).toHaveBeenCalledWith("session-1");
    expect(onDiscard).toHaveBeenCalledWith("session-1");
  });
});
