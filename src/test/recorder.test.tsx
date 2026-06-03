import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecorderBar } from "../components/recorder/RecorderBar";
import {
  combineAudioLevels,
  combineSourceAudioLevels,
  SOURCE_VISUAL_GAIN,
  visualPeakScale,
} from "../components/recorder/Waveform";

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
    expect(screen.getByLabelText("Audio activity")).toBeInTheDocument();
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

  it("drives the waveform from system audio when the mic is quiet", () => {
    render(
      <RecorderBar
        status={{
          sessionId: "session-1",
          state: "recording",
          elapsedMs: 5_000,
          level: { peak: 0.002, rms: 0.001, recentPeaks: [0.002] },
          silenceWarning: false,
          bytesWritten: 4096,
          sources: [
            {
              source: "microphone",
              state: "recording",
              elapsedMs: 5_000,
              bytesWritten: 2048,
              level: { peak: 0.002, rms: 0.001, recentPeaks: [0.002] },
              silenceWarning: false,
              pathFinalized: false,
            },
            {
              source: "system",
              state: "recording",
              elapsedMs: 5_000,
              bytesWritten: 2048,
              level: { peak: 0.8, rms: 0.4, recentPeaks: [0.7] },
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

    expect(screen.getByLabelText("Audio activity")).toBeInTheDocument();
  });

  it("folds multiple source levels into the louder envelope", () => {
    const combined = combineAudioLevels([
      { peak: 0.1, rms: 0.05, recentPeaks: [0.1, 0.2] },
      { peak: 0.8, rms: 0.4, recentPeaks: [0.7] },
    ]);
    expect(combined.peak).toBe(0.8);
    expect(combined.rms).toBe(0.4);
    expect(combined.recentPeaks).toEqual([0.1, 0.7]);
  });

  it("applies source visual gain before folding recorder source levels", () => {
    const combined = combineSourceAudioLevels([
      {
        source: "microphone",
        state: "recording",
        elapsedMs: 5_000,
        bytesWritten: 2048,
        level: { peak: 0.25, rms: 0.1, recentPeaks: [0.2, 0.25] },
        silenceWarning: false,
        pathFinalized: false,
      },
      {
        source: "system",
        state: "recording",
        elapsedMs: 5_000,
        bytesWritten: 2048,
        level: { peak: 0.8, rms: 0.4, recentPeaks: [0.7] },
        silenceWarning: false,
        pathFinalized: false,
      },
    ]);

    expect(combined.peak).toBe(0.25);
    expect(combined.rms).toBe(0.1);
    expect(combined.recentPeaks).toEqual([0.2, 0.25]);
  });

  it("keeps boosted system audio below the waveform ceiling", () => {
    expect(visualPeakScale(0.8 * SOURCE_VISUAL_GAIN.system)).toBeLessThan(0.85);
  });

  it("returns a silent level when no sources are present", () => {
    expect(combineAudioLevels([undefined])).toEqual({
      peak: 0,
      rms: 0,
      recentPeaks: [],
    });
  });

  it("keeps quiet speech visible while leaving loud speech headroom", () => {
    // Near-silence settles to the floor.
    expect(visualPeakScale(0.001)).toBeLessThanOrEqual(0.1);
    // Quiet speech is still clearly visible.
    expect(visualPeakScale(0.02)).toBeGreaterThanOrEqual(0.2);
    // Loud speech reads high but never pegs the ceiling — there's room above it.
    const loud = visualPeakScale(0.15);
    expect(loud).toBeGreaterThan(0.75);
    expect(loud).toBeLessThan(0.95);
    // A genuine peak still reaches (effectively) full height.
    expect(visualPeakScale(0.9)).toBeGreaterThanOrEqual(0.99);
  });
});
