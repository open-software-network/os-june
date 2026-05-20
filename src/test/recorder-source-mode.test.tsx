import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SourceModeControl } from "../components/recorder/SourceModeControl";

describe("SourceModeControl", () => {
  it("shows both required source mode labels", () => {
    render(
      <SourceModeControl
        value="microphoneOnly"
        disabled={false}
        readiness={{ sourceMode: "microphoneOnly", ready: true, sources: [] }}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("radio", { name: "Microphone only" }),
    ).toBeChecked();
    expect(
      screen.getByRole("radio", { name: "Microphone + system audio" }),
    ).toBeInTheDocument();
  });

  it("requests readiness when the user changes mode", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SourceModeControl
        value="microphoneOnly"
        disabled={false}
        readiness={{ sourceMode: "microphoneOnly", ready: true, sources: [] }}
        onChange={onChange}
      />,
    );

    await user.click(
      screen.getByRole("radio", { name: "Microphone + system audio" }),
    );

    expect(onChange).toHaveBeenCalledWith("microphonePlusSystem");
  });

  it("disables mode changes while recording is active", () => {
    render(
      <SourceModeControl
        value="microphonePlusSystem"
        disabled
        readiness={{
          sourceMode: "microphonePlusSystem",
          ready: true,
          sources: [],
        }}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("radio", { name: "Microphone only" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("radio", { name: "Microphone + system audio" }),
    ).toBeDisabled();
  });

  it("shows source-specific readiness failures", () => {
    render(
      <SourceModeControl
        value="microphonePlusSystem"
        disabled={false}
        readiness={{
          sourceMode: "microphonePlusSystem",
          ready: false,
          sources: [
            {
              source: "system",
              required: true,
              ready: false,
              permissionState: "denied",
              deviceAvailable: true,
              captureAvailable: false,
              recoveryAction: "openSystemAudioSettings",
              message:
                "Enable system audio capture in macOS Privacy & Security.",
            },
          ],
        }}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "Enable system audio capture in macOS Privacy & Security.",
      ),
    ).toBeInTheDocument();
  });
});
