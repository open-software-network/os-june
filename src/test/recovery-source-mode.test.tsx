import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecoveryBanner } from "../components/recorder/RecoveryBanner";

describe("RecoveryBanner source mode details", () => {
  it("shows recoverable source bytes separately", () => {
    render(
      <RecoveryBanner
        recoveries={[
          {
            sessionId: "session-1",
            noteId: "note-1",
            sourceMode: "microphonePlusSystem",
            startedAt: "2026-05-19T10:00:00Z",
            partialPathPresent: true,
            finalPathPresent: false,
            bytesFound: 4096,
            sources: [
              {
                source: "microphone",
                partialPathPresent: true,
                finalPathPresent: false,
                bytesFound: 2048,
              },
              {
                source: "system",
                partialPathPresent: true,
                finalPathPresent: false,
                bytesFound: 2048,
              },
            ],
          },
        ]}
        onValidate={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );

    expect(screen.getByText("Microphone: 2048 bytes")).toBeInTheDocument();
    expect(screen.getByText("System audio: 2048 bytes")).toBeInTheDocument();
  });
});
