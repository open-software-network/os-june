import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecoveryBanner } from "../components/recorder/RecoveryBanner";
import type { RecoverableRecordingDto } from "../lib/tauri";

const recovery: RecoverableRecordingDto = {
  sessionId: "session-1",
  noteId: "note-1",
  startedAt: "2026-05-19T10:00:00Z",
  partialPathPresent: true,
  finalPathPresent: false,
  bytesFound: 4096,
};

describe("RecoveryBanner", () => {
  it("surfaces recoverable recordings with validate and discard actions", async () => {
    const user = userEvent.setup();
    const onValidate = vi.fn();
    const onDiscard = vi.fn();
    render(
      <RecoveryBanner
        recoveries={[recovery]}
        onValidate={onValidate}
        onDiscard={onDiscard}
      />,
    );

    expect(screen.getByText("Recoverable recording found")).toBeInTheDocument();
    expect(screen.getByText(/4096 bytes/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Validate" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(onValidate).toHaveBeenCalledWith("session-1");
    expect(onDiscard).toHaveBeenCalledWith("session-1");
  });
});
