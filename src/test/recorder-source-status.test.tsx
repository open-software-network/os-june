import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecorderBar } from "../components/recorder/RecorderBar";

describe("RecorderBar source status", () => {
  it("shows per-source evidence for dual-source recordings", () => {
    render(
      <RecorderBar
        status={{
          sessionId: "session-1",
          state: "recording",
          sourceMode: "microphonePlusSystem",
          elapsedMs: 3_000,
          level: { peak: 0.5, rms: 0.2, recentPeaks: [0.2, 0.5] },
          silenceWarning: false,
          bytesWritten: 4096,
          warnings: [],
          sources: [
            {
              source: "microphone",
              state: "recording",
              elapsedMs: 3_000,
              bytesWritten: 2048,
              level: { peak: 0.5, rms: 0.2, recentPeaks: [0.2, 0.5] },
              silenceWarning: false,
              pathFinalized: false,
            },
            {
              source: "system",
              state: "recording",
              elapsedMs: 3_000,
              bytesWritten: 2048,
              level: { peak: 0.4, rms: 0.15, recentPeaks: [0.1, 0.4] },
              silenceWarning: false,
              pathFinalized: false,
            },
          ],
        }}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    expect(screen.getByText("Microphone")).toBeInTheDocument();
    expect(screen.getByText("System audio")).toBeInTheDocument();
    expect(screen.getAllByText("2048 bytes")).toHaveLength(2);
  });
});
