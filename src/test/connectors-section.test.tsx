import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsSection } from "../components/settings/ConnectorsSection";
import type { ConnectorAccount } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  connectorsList: vi.fn<() => Promise<ConnectorAccount[]>>(),
  connectorsConnect: vi.fn(),
  connectorsDisconnect: vi.fn(),
  connectorsApplyRuntime: vi.fn(),
  hermesBrowserAccess: vi.fn(),
  setHermesBrowserAccess: vi.fn(),
  extensionPairingStatus: vi.fn(),
  registerBrowserExtensionHost: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  connectorsList: mocks.connectorsList,
  connectorsConnect: mocks.connectorsConnect,
  connectorsDisconnect: mocks.connectorsDisconnect,
  connectorsApplyRuntime: mocks.connectorsApplyRuntime,
  hermesBrowserAccess: mocks.hermesBrowserAccess,
  setHermesBrowserAccess: mocks.setHermesBrowserAccess,
  extensionPairingStatus: mocks.extensionPairingStatus,
  registerBrowserExtensionHost: mocks.registerBrowserExtensionHost,
  EXTENSION_PAIRING_CHANGED_EVENT: "june://extension-pairing-changed",
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";

function account(overrides: Partial<ConnectorAccount> = {}): ConnectorAccount {
  const email = overrides.email ?? "alex@example.com";
  return {
    accountId: "acc-1",
    provider: "google",
    email,
    scopes: [GMAIL_READONLY, CALENDAR_EVENTS],
    status: "connected",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connectorsList.mockResolvedValue([]);
  mocks.connectorsConnect.mockResolvedValue(account());
  mocks.connectorsDisconnect.mockResolvedValue(undefined);
  mocks.connectorsApplyRuntime.mockResolvedValue(undefined);
  mocks.hermesBrowserAccess.mockResolvedValue({ enabled: false });
  mocks.setHermesBrowserAccess.mockImplementation(async (enabled: boolean) => ({ enabled }));
  mocks.extensionPairingStatus.mockResolvedValue({ paired: false, listenerRunning: true });
  mocks.registerBrowserExtensionHost.mockResolvedValue({
    manifestPath: "/tmp/co.opensoftware.june.extension.json",
    shimPath: "/tmp/june-nm-shim",
  });
  mocks.listen.mockResolvedValue(() => {});
});

/** Waits for the initial connectorsList load to settle. */
async function findEnabledConnect(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

describe("ConnectorsSection", () => {
  it("lists Browser use as a capability beside the account directory", async () => {
    render(<ConnectorsSection />);

    const row = (await screen.findByText("Browser use")).closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(within(row as HTMLElement).getByText(/page text and screenshots/i)).toBeInTheDocument();
  });

  it("connects Browser use by granting access before registering the native host", async () => {
    render(<ConnectorsSection />);

    const row = (await screen.findByText("Browser use")).closest("li") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(mocks.setHermesBrowserAccess).toHaveBeenCalledWith(true));
    expect(mocks.registerBrowserExtensionHost).toHaveBeenCalledOnce();
    expect(mocks.setHermesBrowserAccess.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.registerBrowserExtensionHost.mock.invocationCallOrder[0],
    );
    expect(await within(row).findByText(/Browser access is on/i)).toBeInTheDocument();
  });

  it("shows a granted but unpaired capability as actionable setup", async () => {
    mocks.hermesBrowserAccess.mockResolvedValue({ enabled: true });
    render(<ConnectorsSection />);

    const row = (await screen.findByText("Browser use")).closest("li") as HTMLElement;
    expect(await within(row).findByText("Finish setup")).toBeInTheDocument();
    expect(within(row).getByText(/Browser access is on/i)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Set up extension" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(within(row).queryByRole("alert")).toBeNull();
  });

  it("updates Browser use to connected when the extension pairing event arrives", async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    mocks.listen.mockImplementation((event: string, handler: (e: { payload: unknown }) => void) => {
      handlers.set(event, handler);
      return Promise.resolve(() => {});
    });
    render(<ConnectorsSection />);

    const row = (await screen.findByText("Browser use")).closest("li") as HTMLElement;
    await userEvent.click(await within(row).findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(mocks.setHermesBrowserAccess).toHaveBeenCalledWith(true));
    await waitFor(() => expect(handlers.has("june://extension-pairing-changed")).toBe(true));
    act(() => {
      handlers.get("june://extension-pairing-changed")?.({
        payload: { paired: true, listenerRunning: true, extensionVersion: "0.1.0" },
      });
    });

    expect(await within(row).findByText("Connected")).toBeInTheDocument();
    expect(within(row).getByText(/version 0\.1\.0/)).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Set up extension" })).toBeNull();
    expect(within(row).queryByText(/finish connecting/i)).toBeNull();
  });

  it("disconnects Browser use by revoking the shared grant", async () => {
    mocks.hermesBrowserAccess.mockResolvedValue({ enabled: true });
    mocks.extensionPairingStatus.mockResolvedValue({
      paired: true,
      listenerRunning: true,
      extensionVersion: "0.1.0",
    });
    render(<ConnectorsSection />);

    const row = (await screen.findByText("Browser use")).closest("li") as HTMLElement;
    await userEvent.click(await within(row).findByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(mocks.setHermesBrowserAccess).toHaveBeenCalledWith(false));
    expect(await within(row).findByRole("button", { name: "Connect" })).toBeInTheDocument();
  });

  it("lists Google with a capability blurb", async () => {
    render(<ConnectorsSection />);
    await findEnabledConnect("Connect Google");

    expect(screen.getByText("Google")).toBeInTheDocument();
    expect(screen.getByText(/mail and calendar for briefings/i)).toBeInTheDocument();
  });

  it("lists connected accounts with feature labels and status", async () => {
    mocks.connectorsList.mockResolvedValue([account()]);
    render(<ConnectorsSection />);

    expect(await screen.findByText(/alex@example\.com/)).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/read mail, manage calendar/i)).toBeInTheDocument();
    // Subscribed to the connectors-changed Tauri event to stay fresh.
    expect(mocks.listen).toHaveBeenCalledWith("june://connectors-changed", expect.any(Function));
  });

  it("keeps local mode to one account: a connected provider offers no second connect", async () => {
    mocks.connectorsList.mockResolvedValue([account()]);
    render(<ConnectorsSection />);
    await screen.findByText(/alex@example\.com/);

    // No "add another account" affordance while one is connected; the base
    // connector servers, triggers, and grants all bind to that single account.
    expect(screen.queryByRole("button", { name: "Connect Google" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add access" })).toBeInTheDocument();
    expect(screen.getByText(/Google tokens stay in your Mac's Keychain/i)).toBeInTheDocument();
  });

  it("connects an account from the feature-bundle dialog and applies the runtime", async () => {
    render(<ConnectorsSection />);

    await userEvent.click(await findEnabledConnect("Connect Google"));
    const dialog = screen.getByRole("dialog", { name: "Connect Google account" });
    // Read mail and read calendar are preselected; add drafting.
    expect(within(dialog).getByRole("checkbox", { name: /read mail/i })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: /read calendar/i })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: /send mail/i })).not.toBeChecked();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /draft replies/i }));

    mocks.connectorsList.mockResolvedValue([account()]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(mocks.connectorsConnect).toHaveBeenCalledWith({
        scopes: ["gmail_read", "gmail_draft", "calendar_read"],
        loginHint: undefined,
      }),
    );
    await waitFor(() => expect(mocks.connectorsApplyRuntime).toHaveBeenCalled());
    expect(await screen.findByText(/alex@example\.com/)).toBeInTheDocument();
  });

  it("shows an inline notice when the connector is not configured in this build", async () => {
    mocks.connectorsConnect.mockRejectedValue({
      code: "connector_not_configured",
      message: "GOOGLE_OAUTH_CLIENT_ID missing",
    });
    render(<ConnectorsSection />);

    await userEvent.click(await findEnabledConnect("Connect Google"));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Connect" }),
    );

    expect(
      await screen.findByText("Google connector isn't configured in this build."),
    ).toBeInTheDocument();
  });

  it("reconnects a lapsed account with the same bundles and a login hint", async () => {
    mocks.connectorsList.mockResolvedValue([account({ status: "reconnect_required" })]);
    render(<ConnectorsSection />);
    await screen.findByText(/alex@example\.com/);

    await userEvent.click(screen.getByRole("button", { name: "Reconnect Google" }));

    await waitFor(() =>
      expect(mocks.connectorsConnect).toHaveBeenCalledWith({
        scopes: ["gmail_read", "calendar_events"],
        loginHint: "alex@example.com",
      }),
    );
    await waitFor(() => expect(mocks.connectorsApplyRuntime).toHaveBeenCalled());
  });

  it("disconnects with the optional Google-side revoke", async () => {
    mocks.connectorsList.mockResolvedValue([account()]);
    render(<ConnectorsSection />);
    await screen.findByText(/alex@example\.com/);

    await userEvent.click(screen.getByRole("button", { name: "Disconnect Google" }));
    const dialog = await screen.findByRole("dialog", { name: /Disconnect alex@example.com/ });
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: /revoke June's access with Google/i }),
    );
    mocks.connectorsList.mockResolvedValue([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() =>
      expect(mocks.connectorsDisconnect).toHaveBeenCalledWith({
        accountId: "acc-1",
        revoke: true,
      }),
    );
    expect(await findEnabledConnect("Connect Google")).toBeInTheDocument();
  });

  it("disconnects without revoking by default", async () => {
    mocks.connectorsList.mockResolvedValue([account()]);
    render(<ConnectorsSection />);
    await screen.findByText(/alex@example\.com/);

    await userEvent.click(screen.getByRole("button", { name: "Disconnect Google" }));
    const dialog = await screen.findByRole("dialog", { name: /Disconnect alex@example.com/ });
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() =>
      expect(mocks.connectorsDisconnect).toHaveBeenCalledWith({
        accountId: "acc-1",
        revoke: false,
      }),
    );
  });
});
