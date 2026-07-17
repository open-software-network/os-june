import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedDevicesSection } from "../components/settings/LinkedDevicesSection";

const mocks = vi.hoisted(() => ({
  beginPairing: vi.fn(),
  pairingStatus: vi.fn(),
  listDevices: vi.fn(),
  approvePairing: vi.fn(),
  renameDevice: vi.fn(),
  revokeDevice: vi.fn(),
  readClipboardText: vi.fn(),
  writeClipboardText: vi.fn(),
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  companionBeginPairing: mocks.beginPairing,
  companionPairingStatus: mocks.pairingStatus,
  companionListDevices: mocks.listDevices,
  companionApprovePairing: mocks.approvePairing,
  companionRenameDevice: mocks.renameDevice,
  companionRevokeDevice: mocks.revokeDevice,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: mocks.readClipboardText,
  writeText: mocks.writeClipboardText,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listDevices.mockResolvedValue([]);
  mocks.beginPairing.mockResolvedValue({
    pairingId: "00000000-0000-0000-0000-000000000001",
    expiresAtMs: Date.now() + 300_000,
    qrSvg: "<svg />",
    pairingCode: "manual-pairing-bootstrap-code",
  });
  mocks.pairingStatus.mockResolvedValue({
    pairingId: "00000000-0000-0000-0000-000000000001",
    expiresAtMs: Date.now() + 300_000,
    state: "waitingForPhone",
    desktopDeviceId: "00000000-0000-0000-0000-000000000002",
    desktopPublicKey: Array(32).fill(7),
  });
  mocks.readClipboardText.mockResolvedValue("manual-pairing-bootstrap-code");
  mocks.writeClipboardText.mockResolvedValue(undefined);
});

describe("LinkedDevicesSection", () => {
  it("shows and copies the same pairing code that can be entered on mobile", async () => {
    const user = userEvent.setup();
    render(<LinkedDevicesSection />);

    await user.click(await screen.findByRole("button", { name: "Show pairing code" }));
    await user.click(screen.getByText("Enter a code instead"));

    expect(screen.getByText("manual-pairing-bootstrap-code")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy pairing code" }));

    expect(mocks.writeClipboardText).toHaveBeenCalledWith("manual-pairing-bootstrap-code");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pairing code copied" })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(mocks.writeClipboardText).toHaveBeenCalledWith(""));
  });

  it("does not erase clipboard content that replaced the copied pairing code", async () => {
    const user = userEvent.setup();
    mocks.readClipboardText.mockResolvedValue("newer clipboard content");
    render(<LinkedDevicesSection />);

    await user.click(await screen.findByRole("button", { name: "Show pairing code" }));
    await user.click(screen.getByText("Enter a code instead"));
    await user.click(screen.getByRole("button", { name: "Copy pairing code" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(mocks.readClipboardText).toHaveBeenCalled());
    expect(mocks.writeClipboardText).not.toHaveBeenCalledWith("");
  });

  it("clears a clipboard write that finishes after pairing is cancelled", async () => {
    const user = userEvent.setup();
    let finishWrite: (() => void) | undefined;
    mocks.writeClipboardText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    render(<LinkedDevicesSection />);

    await user.click(await screen.findByRole("button", { name: "Show pairing code" }));
    await user.click(screen.getByText("Enter a code instead"));
    await user.click(screen.getByRole("button", { name: "Copy pairing code" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    finishWrite?.();

    await waitFor(() => expect(mocks.writeClipboardText).toHaveBeenCalledWith(""));
  });

  it("clears a clipboard write that finishes after leaving settings", async () => {
    const user = userEvent.setup();
    let finishWrite: (() => void) | undefined;
    mocks.writeClipboardText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const { unmount } = render(<LinkedDevicesSection />);

    await user.click(await screen.findByRole("button", { name: "Show pairing code" }));
    await user.click(screen.getByText("Enter a code instead"));
    await user.click(screen.getByRole("button", { name: "Copy pairing code" }));
    unmount();
    finishWrite?.();

    await waitFor(() => expect(mocks.writeClipboardText).toHaveBeenCalledWith(""));
  });
});
