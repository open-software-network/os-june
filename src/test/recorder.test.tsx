import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecorderBar } from "../components/recorder/RecorderBar";
import { visualPeakScale } from "../components/recorder/Waveform";

describe("RecorderBar", () => {
  it("shows elapsed time, waveform evidence, and pause/done actions while recording", () => {
    render(
      <RecorderBar
        status={{
          sessionId: "session-1",
          state: "recording",
          elapsedMs: 65_000,
          level: { peak: 0.7, rms: 0.3, recentPeaks: [0.1, 0.4, 0.7] },
          silenceWarning: false,
          bytesWritten: 4096,
        }}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    expect(screen.getByText("01:05")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.getByLabelText("Microphone activity")).toBeInTheDocument();
  });

  it("uses resume action when paused", async () => {
    const user = userEvent.setup();
    const onResume = vi.fn();
    render(
      <RecorderBar
        status={{
          sessionId: "session-1",
          state: "paused",
          elapsedMs: 2_000,
          level: { peak: 0, rms: 0, recentPeaks: [] },
          silenceWarning: false,
          bytesWritten: 1024,
        }}
        onPause={vi.fn()}
        onResume={onResume}
        onDone={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Resume" }));

    expect(onResume).toHaveBeenCalledWith("session-1");
  });

  it("disables recorder actions while finalizing", () => {
    render(
      <RecorderBar
        status={{
          sessionId: "session-1",
          state: "validating",
          elapsedMs: 2_000,
          level: { peak: 0.2, rms: 0.1, recentPeaks: [0.2] },
          silenceWarning: false,
          bytesWritten: 1024,
        }}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Finalizing" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Working" })).toBeDisabled();
  });

  it("does not surface a silence prompt even when the backend flags it", () => {
    render(
      <RecorderBar
        status={{
          sessionId: "session-1",
          state: "recording",
          elapsedMs: 12_000,
          level: { peak: 0.001, rms: 0.001, recentPeaks: [0.001] },
          silenceWarning: true,
          bytesWritten: 1024,
        }}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    expect(
      screen.queryByText("Microphone input appears silent"),
    ).not.toBeInTheDocument();
  });

  it("amplifies normal speech peaks for visible meter movement", () => {
    expect(visualPeakScale(0.02)).toBeGreaterThanOrEqual(0.4);
    expect(visualPeakScale(0.001)).toBeLessThanOrEqual(0.1);
    expect(visualPeakScale(0.9)).toBe(1);
  });
});
