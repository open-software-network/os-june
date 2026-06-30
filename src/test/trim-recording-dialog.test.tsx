import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TrimRecordingDialog } from "../components/recorder/TrimRecordingDialog";
import type { RecordingTrimPreviewDto } from "../lib/tauri";

const preview: RecordingTrimPreviewDto = {
  sessionId: "rec-1",
  durationMs: 60_000,
  peaks: [0.1, 0.5, 0.9, 0.4, 0.2],
  sourceMode: "microphoneOnly",
};

describe("TrimRecordingDialog", () => {
  it("shows a loading state until the waveform preview arrives", () => {
    render(
      <TrimRecordingDialog
        open
        preview={undefined}
        preparing
        busy={false}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Preparing waveform…")).toBeInTheDocument();
  });

  it("finalizes the full recording with no trim by default", async () => {
    const onConfirm = vi.fn();
    render(
      <TrimRecordingDialog
        open
        preview={preview}
        preparing={false}
        busy={false}
        onConfirm={onConfirm}
      />,
    );
    // Untrimmed, the primary action keeps the whole clip.
    expect(screen.getByText(/Full recording, 01:00/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Save and transcribe" }),
    );
    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it("trims from the start with the keyboard and confirms a range", async () => {
    const onConfirm = vi.fn();
    render(
      <TrimRecordingDialog
        open
        preview={preview}
        preparing={false}
        busy={false}
        onConfirm={onConfirm}
      />,
    );
    // Step is max(250, duration/100) == 600ms for a 60s clip.
    fireEvent.keyDown(screen.getByRole("slider", { name: "Trim start" }), {
      key: "ArrowRight",
    });
    expect(screen.getByText(/Keeping 00:59 of 01:00/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Trim and transcribe" }),
    );
    expect(onConfirm).toHaveBeenCalledWith({ startMs: 600, endMs: 60_000 });
  });

  it("lets the user keep the full recording explicitly", async () => {
    const onConfirm = vi.fn();
    render(
      <TrimRecordingDialog
        open
        preview={preview}
        preparing={false}
        busy={false}
        onConfirm={onConfirm}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Use full recording" }),
    );
    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it("disables the confirm actions while finalizing", () => {
    render(
      <TrimRecordingDialog
        open
        preview={preview}
        preparing={false}
        busy
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });
});
