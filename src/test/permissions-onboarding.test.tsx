import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionsOnboarding } from "../components/onboarding/PermissionsOnboarding";

const mocks = vi.hoisted(() => ({
  checkRecordingSourceReadiness: vi.fn(),
  dictationHelperCommand: vi.fn(),
  openPrivacySettings: vi.fn(),
  listen: vi.fn(),
  eventHandler: undefined as ((event: { payload: string }) => void) | undefined,
}));

vi.mock("../lib/tauri", () => ({
  checkRecordingSourceReadiness: mocks.checkRecordingSourceReadiness,
  dictationHelperCommand: mocks.dictationHelperCommand,
  openPrivacySettings: mocks.openPrivacySettings,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

describe("PermissionsOnboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventHandler = undefined;
    mocks.dictationHelperCommand.mockResolvedValue(undefined);
    mocks.openPrivacySettings.mockResolvedValue(undefined);
    mocks.checkRecordingSourceReadiness.mockResolvedValue({
      sourceMode: "microphonePlusSystem",
      ready: false,
      checkedAt: "2026-05-26T10:00:00Z",
      sources: [
        {
          source: "microphone",
          required: true,
          ready: true,
          permissionState: "granted",
          deviceAvailable: true,
          captureAvailable: true,
        },
        {
          source: "system",
          required: true,
          ready: false,
          permissionState: "denied",
          deviceAvailable: true,
          captureAvailable: false,
        },
      ],
    });
    mocks.listen.mockImplementation((_event, handler) => {
      mocks.eventHandler = handler;
      return Promise.resolve(vi.fn());
    });
  });

  it("shows permission status and opens the matching settings panes", async () => {
    const user = userEvent.setup();

    render(<PermissionsOnboarding open onComplete={vi.fn()} />);

    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "get_permission_status",
      }),
    );
    expect(mocks.checkRecordingSourceReadiness).toHaveBeenCalledWith(
      "microphonePlusSystem",
    );

    mocks.eventHandler?.({
      payload: JSON.stringify({
        type: "permission_status",
        payload: { microphone: "authorized", accessibility: "denied" },
      }),
    });

    expect(await screen.findByText("Allowed")).toBeInTheDocument();
    expect(screen.getAllByText("Needs permission")).toHaveLength(2);

    const openButtons = screen.getAllByRole("button", { name: /Open/ });
    await user.click(openButtons[0]);
    await user.click(openButtons[1]);
    await user.click(openButtons[2]);

    expect(mocks.openPrivacySettings).toHaveBeenNthCalledWith(1, "microphone");
    expect(mocks.openPrivacySettings).toHaveBeenNthCalledWith(
      2,
      "accessibility",
    );
    expect(mocks.openPrivacySettings).toHaveBeenNthCalledWith(3, "systemAudio");
  });

  it("lets users finish onboarding even before every permission is granted", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();

    render(<PermissionsOnboarding open onComplete={onComplete} />);

    await user.click(
      await screen.findByRole("button", { name: "Skip for now" }),
    );

    expect(onComplete).toHaveBeenCalledOnce();
  });
});
