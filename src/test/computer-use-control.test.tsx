import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  computerUseStatus: vi.fn(),
  setComputerUseGrant: vi.fn(),
  computerUseRequestPermissions: vi.fn(),
  computerUseStop: vi.fn(),
  openPrivacySettings: vi.fn(),
  setComputerUsePermissionDragBounds: vi.fn(),
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  computerUseStatus: tauriMocks.computerUseStatus,
  setComputerUseGrant: tauriMocks.setComputerUseGrant,
  computerUseRequestPermissions: tauriMocks.computerUseRequestPermissions,
  computerUseStop: tauriMocks.computerUseStop,
  openPrivacySettings: tauriMocks.openPrivacySettings,
  setComputerUsePermissionDragBounds: tauriMocks.setComputerUsePermissionDragBounds,
}));

import { ComputerUseControl } from "../components/plugins/ComputerUseControl";
import { PluginsView } from "../components/plugins/PluginsView";
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
  tauriMocks.setComputerUseGrant.mockResolvedValue(
    status({ grantEnabled: true, state: "permission_missing" }),
  );
  tauriMocks.computerUseRequestPermissions.mockResolvedValue(
    status({
      grantEnabled: true,
      accessibility: true,
      screenRecording: true,
      ready: true,
      state: "ready",
    }),
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
    expect(tauriMocks.computerUseRequestPermissions).not.toHaveBeenCalled();
  });

  it("explains both permissions before the explicit macOS request", async () => {
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({ grantEnabled: true, state: "permission_missing" }),
    );
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);

    expect(await screen.findByText("Accessibility")).toBeInTheDocument();
    expect(screen.getByText("Screen recording")).toBeInTheDocument();
    expect(screen.getByText(/Captures are never analytics/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Continue to macOS access" }));
    expect(tauriMocks.computerUseRequestPermissions).toHaveBeenCalledTimes(1);
  });

  it("offers the real helper app as a drag source when macOS access is missing", async () => {
    tauriMocks.computerUseStatus.mockResolvedValue(
      status({ grantEnabled: true, state: "permission_missing" }),
    );
    render(<ComputerUseControl onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);

    expect(await screen.findByText("Add June to macOS")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Drag June Computer Use Driver to the open System Settings list",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/No Finder browsing needed/)).toBeInTheDocument();
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
    expect(screen.getByText(/macOS will ask for Accessibility/)).toBeInTheDocument();
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

  it("exposes Computer use from the Plugins settings page", async () => {
    render(<PluginsView onOpenModels={vi.fn()} onOpenBilling={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Plugins" })).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Enable Computer use" })).toBeInTheDocument();
    expect(SETTINGS_TABS).toContainEqual({ id: "plugins", label: "Plugins" });
    expect(SETTINGS_TABS.some((tab) => tab.label === "Connectors")).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Open Computer use settings" }),
    ).not.toBeInTheDocument();
  });
});
