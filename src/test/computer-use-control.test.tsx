import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  computerUseStatus: vi.fn(),
  computerUseRequestPermissions: vi.fn(),
  setComputerUseGrant: vi.fn(),
  computerUseStop: vi.fn(),
  openPrivacySettings: vi.fn(),
  setComputerUsePermissionDragBounds: vi.fn(),
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  computerUseStatus: tauriMocks.computerUseStatus,
  computerUseRequestPermissions: tauriMocks.computerUseRequestPermissions,
  setComputerUseGrant: tauriMocks.setComputerUseGrant,
  computerUseStop: tauriMocks.computerUseStop,
  openPrivacySettings: tauriMocks.openPrivacySettings,
  setComputerUsePermissionDragBounds: tauriMocks.setComputerUsePermissionDragBounds,
}));

import { ComputerUseControl } from "../components/plugins/ComputerUseControl";
import { SETTINGS_TABS } from "../components/settings/AppSettings";
import type { ComputerUseStatusDto } from "../lib/tauri";

function status(overrides: Partial<ComputerUseStatusDto> = {}): ComputerUseStatusDto {
  return {
    platformSupported: true,
    planEligible: true,
    grantEnabled: false,
    driverAvailable: true,
    driverVersion: "0.5.0",
    accessibility: false,
    screenRecording: false,
    modelSupportsVision: true,
    generationModel: "vision-model",
    ready: false,
    state: "off",
    ...overrides,
  };
}

beforeEach(() => {
  tauriMocks.computerUseStatus.mockResolvedValue(status());
  tauriMocks.computerUseRequestPermissions.mockResolvedValue(
    status({ grantEnabled: true, state: "permission_missing" }),
  );
  tauriMocks.setComputerUseGrant.mockResolvedValue(
    status({ grantEnabled: true, state: "permission_missing" }),
  );
  tauriMocks.computerUseStop.mockResolvedValue({ stopped: true });
  tauriMocks.openPrivacySettings.mockResolvedValue(undefined);
  tauriMocks.setComputerUsePermissionDragBounds.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ComputerUseControl", () => {
  it("enables the June grant without prompting for macOS access", async () => {
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);
    const toggle = await screen.findByRole("switch", { name: "Enable Computer use" });

    await userEvent.click(toggle);

    expect(tauriMocks.setComputerUseGrant).toHaveBeenCalledWith(true);
    expect(tauriMocks.openPrivacySettings).not.toHaveBeenCalled();
    expect(screen.queryByText(/Computer use is enabled/)).toBeNull();
  });

  it("guides the user through Accessibility as the first macOS step", async () => {
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({ grantEnabled: true, state: "permission_missing" }),
    );
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);

    expect(await screen.findByText("Allow Accessibility")).toBeInTheDocument();
    expect(screen.getByText("Screen recording")).toBeInTheDocument();
    expect(screen.queryByText(/Captures are never analytics/)).not.toBeInTheDocument();
    expect(
      screen.getByText((_, element) =>
        Boolean(
          element?.tagName === "P" &&
            element.textContent?.includes(
              "Open System Settings, find June Computer Use Driver, and turn it on.",
            ),
        ),
      ),
    ).toBeInTheDocument();

    await userEvent.hover(
      screen.getByRole("button", { name: "Computer use privacy and permissions" }),
    );
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/Captures are never analytics/);

    await userEvent.click(screen.getByRole("button", { name: "Open Accessibility settings" }));
    expect(tauriMocks.computerUseRequestPermissions).toHaveBeenCalledTimes(1);
    expect(tauriMocks.openPrivacySettings).toHaveBeenCalledWith("accessibility");
    expect(screen.queryByRole("button", { name: "Continue to macOS access" })).toBeNull();
  });

  it("advances to Screen recording after Accessibility is allowed", async () => {
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({ grantEnabled: true, accessibility: true, state: "permission_missing" }),
    );
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);

    expect(await screen.findByText("Step 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("Allow Screen recording")).toBeInTheDocument();
    expect(screen.getByText(/assigns Screen recording to June itself/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Drag June to the open System Settings list",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Drag June below/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Screen recording settings" }));
    expect(tauriMocks.computerUseRequestPermissions).toHaveBeenCalledTimes(1);
    expect(tauriMocks.openPrivacySettings).toHaveBeenCalledWith("screenRecording");
  });

  it("coalesces repeated permission probes before opening Screen recording settings", async () => {
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({ grantEnabled: true, accessibility: true, state: "permission_missing" }),
    );
    let finishPermissionProbe: ((value: ComputerUseStatusDto) => void) | undefined;
    tauriMocks.computerUseRequestPermissions.mockImplementationOnce(
      () =>
        new Promise<ComputerUseStatusDto>((resolve) => {
          finishPermissionProbe = resolve;
        }),
    );
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);

    const button = await screen.findByRole("button", { name: "Open Screen recording settings" });
    await userEvent.click(button);
    await userEvent.click(button);

    expect(tauriMocks.computerUseRequestPermissions).toHaveBeenCalledTimes(1);
    expect(tauriMocks.openPrivacySettings).not.toHaveBeenCalled();

    const readyStatus = status({
      grantEnabled: true,
      accessibility: true,
      screenRecording: true,
      ready: true,
      state: "ready",
    });
    tauriMocks.computerUseStatus.mockResolvedValue(readyStatus);
    finishPermissionProbe?.(readyStatus);
    await waitFor(() => expect(tauriMocks.openPrivacySettings).toHaveBeenCalledTimes(2));
    expect(tauriMocks.openPrivacySettings).toHaveBeenLastCalledWith("screenRecording");
    await screen.findByText("Ready");
  });

  it("waits for each status poll before scheduling the next one", async () => {
    vi.useFakeTimers();
    try {
      const incomplete = status({ grantEnabled: true, state: "permission_missing" });
      let finishPoll: ((value: ComputerUseStatusDto) => void) | undefined;
      tauriMocks.computerUseStatus
        .mockResolvedValueOnce(incomplete)
        .mockImplementationOnce(
          () =>
            new Promise<ComputerUseStatusDto>((resolve) => {
              finishPoll = resolve;
            }),
        )
        .mockResolvedValue(incomplete);

      render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(tauriMocks.computerUseStatus).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(tauriMocks.computerUseStatus).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(tauriMocks.computerUseStatus).toHaveBeenCalledTimes(2);

      await act(async () => {
        finishPoll?.(incomplete);
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(tauriMocks.computerUseStatus).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses status polling while the settings page is hidden", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    const visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    try {
      const incomplete = status({ grantEnabled: true, state: "permission_missing" });
      tauriMocks.computerUseStatus.mockResolvedValue(incomplete);
      render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);
      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(tauriMocks.computerUseStatus).toHaveBeenCalledTimes(2);

      visibility = "hidden";
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(tauriMocks.computerUseStatus).toHaveBeenCalledTimes(2);

      visibility = "visible";
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await Promise.resolve();
      });
      expect(tauriMocks.computerUseStatus).toHaveBeenCalledTimes(3);
    } finally {
      visibilitySpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("coalesces a permission probe across an unmount and remount", async () => {
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({ grantEnabled: true, accessibility: true, state: "permission_missing" }),
    );
    let finishPermissionProbe: ((value: ComputerUseStatusDto) => void) | undefined;
    tauriMocks.computerUseRequestPermissions.mockImplementationOnce(
      () =>
        new Promise<ComputerUseStatusDto>((resolve) => {
          finishPermissionProbe = resolve;
        }),
    );
    const first = render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Open Screen recording settings" }),
    );

    first.unmount();
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Open Screen recording settings" }),
    );

    expect(tauriMocks.computerUseRequestPermissions).toHaveBeenCalledTimes(1);
    const readyStatus = status({
      grantEnabled: true,
      accessibility: true,
      screenRecording: true,
      ready: true,
      state: "ready",
    });
    tauriMocks.computerUseStatus.mockResolvedValue(readyStatus);
    finishPermissionProbe?.(readyStatus);
    await screen.findByText("Ready");
  });

  it("queues a newly reached permission pane behind an active probe", async () => {
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({ grantEnabled: true, state: "permission_missing" }),
    );
    let finishAccessibilityProbe: ((value: ComputerUseStatusDto) => void) | undefined;
    let finishScreenRecordingProbe: ((value: ComputerUseStatusDto) => void) | undefined;
    tauriMocks.computerUseRequestPermissions
      .mockImplementationOnce(
        () =>
          new Promise<ComputerUseStatusDto>((resolve) => {
            finishAccessibilityProbe = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ComputerUseStatusDto>((resolve) => {
            finishScreenRecordingProbe = resolve;
          }),
      );
    const first = render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Open Accessibility settings" }),
    );

    first.unmount();
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({ grantEnabled: true, accessibility: true, state: "permission_missing" }),
    );
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Open Screen recording settings" }),
    );

    expect(tauriMocks.computerUseRequestPermissions).toHaveBeenCalledTimes(1);
    finishAccessibilityProbe?.(
      status({ grantEnabled: true, accessibility: true, state: "permission_missing" }),
    );
    await waitFor(() => expect(tauriMocks.computerUseRequestPermissions).toHaveBeenCalledTimes(2));
    const readyStatus = status({
      grantEnabled: true,
      accessibility: true,
      screenRecording: true,
      ready: true,
      state: "ready",
    });
    tauriMocks.computerUseStatus.mockResolvedValue(readyStatus);
    finishScreenRecordingProbe?.(readyStatus);
    await screen.findByText("Ready");
  });

  it("keeps Accessibility labeled as step 1 when Screen recording was allowed first", async () => {
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({ grantEnabled: true, screenRecording: true, state: "permission_missing" }),
    );
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);

    expect(await screen.findByText("Step 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Allow Accessibility")).toBeInTheDocument();
  });

  it("offers the real helper app as a drag source when macOS access is missing", async () => {
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({ grantEnabled: true, state: "permission_missing" }),
    );
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);

    expect(await screen.findByText("Driver is not in the list?")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Drag June Computer Use Driver to the open System Settings list",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Drag the helper below/)).toBeInTheDocument();
  });

  it("registers the permission owner represented by each drag card", async () => {
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({ grantEnabled: true, state: "permission_missing" }),
    );
    const { unmount } = render(
      <ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />,
    );

    await screen.findByRole("button", {
      name: "Drag June Computer Use Driver to the open System Settings list",
    });
    await waitFor(() =>
      expect(tauriMocks.setComputerUsePermissionDragBounds).toHaveBeenCalledWith(
        expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
        "helper",
      ),
    );

    unmount();
    tauriMocks.setComputerUsePermissionDragBounds.mockClear();
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({ grantEnabled: true, accessibility: true, state: "permission_missing" }),
    );
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);

    await screen.findByRole("button", {
      name: "Drag June to the open System Settings list",
    });
    await waitFor(() =>
      expect(tauriMocks.setComputerUsePermissionDragBounds).toHaveBeenCalledWith(
        expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
        "host",
      ),
    );
  });

  it("does not expose helper transport errors while permissions are incomplete", async () => {
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({
        grantEnabled: true,
        state: "permission_missing",
        error: "Broken pipe (os error 32)",
      }),
    );
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);

    expect(await screen.findByText("Allow Accessibility")).toBeInTheDocument();
    expect(screen.queryByText(/Broken pipe/)).toBeNull();
  });

  it("shows helper errors that are not permission setup failures", async () => {
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({
        grantEnabled: true,
        state: "error",
        error: "The Computer use driver did not respond in time.",
      }),
    );
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);

    expect(await screen.findByText(/driver did not respond in time/)).toBeInTheDocument();
  });

  it("routes a model mismatch to the model picker", async () => {
    const onOpenModels = vi.fn();
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({
        grantEnabled: true,
        accessibility: true,
        screenRecording: true,
        modelSupportsVision: false,
        generationModel: "text-only-model",
        state: "model_unsupported",
      }),
    );
    render(<ComputerUseControl onOpenModels={onOpenModels} onOpenBilling={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Choose model" }));
    expect(onOpenModels).toHaveBeenCalledTimes(1);
  });

  it("keeps the switch unavailable off macOS", async () => {
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({ platformSupported: false, driverAvailable: false, state: "unsupported" }),
    );
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);

    const toggle = await screen.findByRole("switch", { name: "Enable Computer use" });
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(screen.getByText(/available on macOS only/)).toBeInTheDocument();
  });

  it("keeps the native grant off without an active plan", async () => {
    const onOpenBilling = vi.fn();
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({ planEligible: false, driverAvailable: false, state: "plan_required" }),
    );
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={onOpenBilling} />);

    expect(await screen.findByRole("switch", { name: "Enable Computer use" })).toBeDisabled();
    expect(screen.queryByText(/macOS will ask for Accessibility/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View plans" }));
    expect(onOpenBilling).toHaveBeenCalledTimes(1);
  });

  it("disables setup while the safety rollout is paused", async () => {
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({
        grantEnabled: false,
        driverAvailable: false,
        state: "rollout_disabled",
        error: "Computer use is temporarily unavailable for this June or macOS version.",
      }),
    );
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);

    expect(await screen.findByRole("switch", { name: "Enable Computer use" })).toBeDisabled();
    expect(screen.getAllByText("Temporarily unavailable")).toHaveLength(2);
    expect(
      screen.getAllByText(/temporarily unavailable for this June or macOS version/),
    ).toHaveLength(1);
    expect(screen.queryByText("Bundled driver unavailable")).not.toBeInTheDocument();
  });

  it("renders Computer use as a plugin row without a Pro tag", async () => {
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);

    expect(await screen.findByRole("switch", { name: "Enable Computer use" })).toBeInTheDocument();
    expect(screen.getByText("Computer use").closest("li")).toHaveClass("connector-row");
    expect(screen.queryByText("Pro")).not.toBeInTheDocument();
    expect(SETTINGS_TABS).toContainEqual({ id: "connectors", label: "Plugins" });
  });
});
