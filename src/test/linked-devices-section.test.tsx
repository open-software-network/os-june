import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedDevicesSection } from "../components/settings/LinkedDevicesSection";

const mocks = vi.hoisted(() => ({
  beginPairing: vi.fn(),
  pairingStatus: vi.fn(),
  listDevices: vi.fn(),
  listBrowseRoots: vi.fn(),
  grantBrowseRoot: vi.fn(),
  revokeBrowseRoot: vi.fn(),
  approvePairing: vi.fn(),
  renameDevice: vi.fn(),
  revokeDevice: vi.fn(),
  computerUseApprovalSettings: vi.fn(),
  setComputerUseApprovalEnabled: vi.fn(),
  writeClipboardText: vi.fn(),
  openBrowseRoot: vi.fn(),
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  companionBeginPairing: mocks.beginPairing,
  companionPairingStatus: mocks.pairingStatus,
  companionListDevices: mocks.listDevices,
  companionListBrowseRoots: mocks.listBrowseRoots,
  companionGrantBrowseRoot: mocks.grantBrowseRoot,
  companionRevokeBrowseRoot: mocks.revokeBrowseRoot,
  companionApprovePairing: mocks.approvePairing,
  companionRenameDevice: mocks.renameDevice,
  companionRevokeDevice: mocks.revokeDevice,
  companionComputerUseApprovalSettings: mocks.computerUseApprovalSettings,
  companionSetComputerUseApprovalEnabled: mocks.setComputerUseApprovalEnabled,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: mocks.writeClipboardText,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.openBrowseRoot,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listDevices.mockResolvedValue([]);
  mocks.listBrowseRoots.mockResolvedValue([]);
  mocks.openBrowseRoot.mockResolvedValue(null);
  mocks.grantBrowseRoot.mockResolvedValue({
    id: "00000000-0000-0000-0000-000000000003",
    name: "Project",
    path: "/Users/june/Project",
  });
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
  mocks.writeClipboardText.mockResolvedValue(undefined);
  mocks.computerUseApprovalSettings.mockResolvedValue({
    enabled: false,
    available: true,
  });
  mocks.setComputerUseApprovalEnabled.mockResolvedValue({
    enabled: true,
    available: true,
  });
});

describe("LinkedDevicesSection", () => {
  it("shows model read and edit as separate linked-device grants", async () => {
    mocks.listDevices.mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000003",
        displayName: "Jakub's iPhone",
        linkedAt: "2026-07-28T10:00:00Z",
        capabilities: ["modelRead", "modelEdit"],
      },
    ]);

    render(<LinkedDevicesSection />);

    expect(await screen.findByText("View agent models")).toBeInTheDocument();
    expect(screen.getByText("Change agent models")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlink" })).toBeInTheDocument();
  });

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
    expect(mocks.writeClipboardText).toHaveBeenCalledTimes(1);
  });

  it("does not erase clipboard content when pairing ends", async () => {
    const user = userEvent.setup();
    render(<LinkedDevicesSection />);

    await user.click(await screen.findByRole("button", { name: "Show pairing code" }));
    await user.click(screen.getByText("Enter a code instead"));
    expect(screen.getByText(/clipboard history/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy pairing code" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mocks.writeClipboardText).not.toHaveBeenCalledWith("");
  });

  it("shows persisted Mac folder grants and revokes one explicitly", async () => {
    mocks.listBrowseRoots.mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000003",
        name: "Project",
        path: "/Users/june/Project",
      },
    ]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<LinkedDevicesSection />);

    expect(await screen.findByText("/Users/june/Project")).toBeInTheDocument();
    expect(screen.getByText(/cannot be downloaded/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop sharing" }));

    expect(mocks.revokeBrowseRoot).toHaveBeenCalledWith("00000000-0000-0000-0000-000000000003");
  });

  it("grants only the folder returned by the native directory picker", async () => {
    mocks.openBrowseRoot.mockResolvedValue("/Users/june/Project");
    const user = userEvent.setup();
    render(<LinkedDevicesSection />);

    await user.click(await screen.findByRole("button", { name: "Add folder" }));

    expect(mocks.openBrowseRoot).toHaveBeenCalledWith({ directory: true, multiple: false });
    await waitFor(() => expect(mocks.grantBrowseRoot).toHaveBeenCalledWith("/Users/june/Project"));
  });

  it("shows phone upload access per device and unlinks to revoke it", async () => {
    mocks.listDevices.mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000004",
        displayName: "Travel phone",
        linkedAt: "2026-07-28T00:00:00Z",
        capabilities: ["filesUpload", "devicesRevokeSelf"],
      },
    ]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<LinkedDevicesSection />);

    expect(await screen.findByText("Add phone attachments")).toBeInTheDocument();
    expect(screen.getByText(/unlink it to revoke this access/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unlink" }));

    expect(mocks.revokeDevice).toHaveBeenCalledWith("00000000-0000-0000-0000-000000000004");
  });

  it("shows generated media access in each linked device's granted capabilities", async () => {
    mocks.listDevices.mockResolvedValue([
      {
        id: "device-1",
        displayName: "Clovy Companion",
        linkedAt: "2026-07-28T10:00:00Z",
        capabilities: ["mediaRead"],
      },
    ]);

    render(<LinkedDevicesSection />);

    expect(await screen.findByText("Read generated media")).toBeInTheDocument();
  });

  it("keeps linked Computer use approvals off until the desktop user opts in", async () => {
    const user = userEvent.setup();
    render(<LinkedDevicesSection />);

    const approvalSwitch = await screen.findByRole("switch", {
      name: "Approve Computer use from linked devices",
    });
    expect(approvalSwitch).toHaveAttribute("aria-checked", "false");

    await user.click(approvalSwitch);

    expect(mocks.setComputerUseApprovalEnabled).toHaveBeenCalledWith(true);
    await waitFor(() => expect(approvalSwitch).toHaveAttribute("aria-checked", "true"));
  });

  it("shows the approval capability and existing revoke control for each linked device", async () => {
    mocks.listDevices.mockResolvedValue([
      {
        id: "device-1",
        displayName: "Jakub's iPhone",
        linkedAt: "2026-07-28T12:00:00Z",
        capabilities: ["computerUseApprove"],
      },
    ]);

    render(<LinkedDevicesSection />);

    expect(await screen.findByText("Approve Computer use actions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlink" })).toBeInTheDocument();
  });
});
