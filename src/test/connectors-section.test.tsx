import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsSection } from "../components/settings/ConnectorsSection";
import type { ConnectorAccount, LinearTeam } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  connectorsList: vi.fn<() => Promise<ConnectorAccount[]>>(),
  connectorsConnect: vi.fn(),
  connectorsCancelConnect: vi.fn(),
  connectorsDisconnect: vi.fn(),
  connectorsApplyRuntime: vi.fn(),
  hermesBrowserAccess: vi.fn(),
  setHermesBrowserAccess: vi.fn(),
  extensionPairingStatus: vi.fn(),
  registerBrowserExtensionHost: vi.fn(),
  browserTransportPolicy: vi.fn(),
  connectorsLinearTeams: vi.fn(),
  connectorsSetSelectedTeams: vi.fn(),
  obsidianStatus: vi.fn(),
  obsidianConfigure: vi.fn(),
  obsidianDisconnect: vi.fn(),
  openFileDialog: vi.fn(),
  notionConnectorConnect: vi.fn(),
  notionConnectorDisconnect: vi.fn(),
  listen: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

// Pin BROWSER_USE_ENABLED on so the Browser use capability row stays testable
// regardless of the committed flag value.
vi.mock("../lib/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/feature-flags")>()),
  BROWSER_USE_ENABLED: true,
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  connectorsList: mocks.connectorsList,
  connectorsConnect: mocks.connectorsConnect,
  connectorsCancelConnect: mocks.connectorsCancelConnect,
  connectorsDisconnect: mocks.connectorsDisconnect,
  connectorsApplyRuntime: mocks.connectorsApplyRuntime,
  hermesBrowserAccess: mocks.hermesBrowserAccess,
  setHermesBrowserAccess: mocks.setHermesBrowserAccess,
  extensionPairingStatus: mocks.extensionPairingStatus,
  registerBrowserExtensionHost: mocks.registerBrowserExtensionHost,
  browserTransportPolicy: mocks.browserTransportPolicy,
  EXTENSION_PAIRING_CHANGED_EVENT: "june://extension-pairing-changed",
  connectorsLinearTeams: mocks.connectorsLinearTeams,
  connectorsSetSelectedTeams: mocks.connectorsSetSelectedTeams,
  obsidianStatus: mocks.obsidianStatus,
  obsidianConfigure: mocks.obsidianConfigure,
  obsidianDisconnect: mocks.obsidianDisconnect,
  notionConnectorConnect: mocks.notionConnectorConnect,
  notionConnectorDisconnect: mocks.notionConnectorDisconnect,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.openFileDialog,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("../components/ui/Toaster", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

vi.mock("../components/plugins/ComputerUseControl", () => ({
  ComputerUseControl: () => (
    <li className="connector-row">
      <span>Computer use</span>
    </li>
  ),
}));

const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";

const TEAM_ENG: LinearTeam = { id: "team-eng", key: "ENG", name: "Engineering" };
const TEAM_DESIGN: LinearTeam = { id: "team-design", key: "DES", name: "Design" };
let connectorsChangedListener: (() => void) | null = null;
// Map from event name to its handler so device-code events can be fired
// independently of the connectors-changed event.
const eventHandlers = new Map<string, (event: { payload: unknown }) => void>();

function account(overrides: Partial<ConnectorAccount> = {}): ConnectorAccount {
  const email = overrides.email ?? "alex@example.com";
  return {
    accountId: "acc-1",
    provider: "google",
    email,
    scopes: [GMAIL_READONLY, CALENDAR_EVENTS],
    status: "connected",
    workspaceName: null,
    workspaceUrlKey: null,
    selectedTeams: [],
    ...overrides,
  };
}

function linearAccount(overrides: Partial<ConnectorAccount> = {}): ConnectorAccount {
  return {
    accountId: "linear-acc-1",
    provider: "linear",
    email: "alex@example.com",
    scopes: ["read"],
    status: "connected",
    workspaceName: "Acme",
    workspaceUrlKey: "acme",
    selectedTeams: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  connectorsChangedListener = null;
  eventHandlers.clear();
  mocks.connectorsList.mockResolvedValue([]);
  mocks.connectorsConnect.mockResolvedValue(account());
  mocks.connectorsDisconnect.mockResolvedValue(undefined);
  mocks.connectorsApplyRuntime.mockResolvedValue(undefined);
  mocks.connectorsCancelConnect.mockResolvedValue(undefined);
  mocks.connectorsLinearTeams.mockResolvedValue({
    teams: [TEAM_ENG, TEAM_DESIGN],
    truncated: false,
  });
  mocks.connectorsSetSelectedTeams.mockResolvedValue(linearAccount({ selectedTeams: [TEAM_ENG] }));
  mocks.hermesBrowserAccess.mockResolvedValue({ enabled: false });
  mocks.setHermesBrowserAccess.mockImplementation(async (enabled: boolean) => ({ enabled }));
  mocks.extensionPairingStatus.mockResolvedValue({ paired: false, listenerRunning: true });
  mocks.registerBrowserExtensionHost.mockResolvedValue({
    manifestPath: "/tmp/co.opensoftware.june.extension.json",
    shimPath: "/tmp/june-nm-shim",
  });
  mocks.browserTransportPolicy.mockResolvedValue({
    attendedEnabled: true,
    managedEnabled: true,
  });
  mocks.obsidianStatus.mockResolvedValue({ connected: false });
  mocks.obsidianConfigure.mockResolvedValue({
    connected: true,
    vaultPath: "/vaults/work",
    vaultName: "work",
  });
  mocks.obsidianDisconnect.mockResolvedValue({ connected: false });
  mocks.openFileDialog.mockResolvedValue(null);
  mocks.listen.mockImplementation(
    async (event: string, handler: (e: { payload: unknown }) => void) => {
      // Store every handler by event name so tests can fire specific events.
      eventHandlers.set(event, handler);
      // Backward-compat: keep the single-listener reference for legacy tests
      // that only care about the connectors-changed event.
      if (event === "june://connectors-changed") {
        connectorsChangedListener = () => handler({ payload: undefined });
      }
      return () => {};
    },
  );
  mocks.notionConnectorConnect.mockResolvedValue({
    accountId: "notion-hosted-mcp",
    endpoint: "https://mcp.notion.com/mcp",
    preview: true,
    selectedResourceScopingVerified: false,
  });
  mocks.notionConnectorDisconnect.mockResolvedValue(undefined);
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

  it("explains and disables attended setup when its transport is remotely disabled", async () => {
    mocks.browserTransportPolicy.mockResolvedValue({
      attendedEnabled: false,
      managedEnabled: true,
    });
    render(<ConnectorsSection />);

    const row = (await screen.findByText("Browser use")).closest("li") as HTMLElement;
    expect(
      await within(row).findByText(/attended sessions is temporarily unavailable/i),
    ).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(within(row).getByText("Temporarily unavailable")).toBeInTheDocument();
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

  it("subscribes before reading pairing state and ignores an older snapshot", async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    let finishPairingListen: ((cleanup: () => void) => void) | undefined;
    let finishStatus: ((status: { paired: boolean; listenerRunning: boolean }) => void) | undefined;
    mocks.hermesBrowserAccess.mockResolvedValue({ enabled: true });
    mocks.extensionPairingStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStatus = resolve;
        }),
    );
    mocks.listen.mockImplementation((event: string, handler: (e: { payload: unknown }) => void) => {
      handlers.set(event, handler);
      if (event === "june://extension-pairing-changed") {
        return new Promise((resolve) => {
          finishPairingListen = resolve;
        });
      }
      return Promise.resolve(() => {});
    });

    render(<ConnectorsSection />);

    await waitFor(() => expect(finishPairingListen).toBeDefined());
    expect(mocks.extensionPairingStatus).not.toHaveBeenCalled();
    act(() => finishPairingListen?.(() => {}));
    await waitFor(() => expect(mocks.extensionPairingStatus).toHaveBeenCalledOnce());

    act(() => {
      handlers.get("june://extension-pairing-changed")?.({
        payload: { paired: true, listenerRunning: true, extensionVersion: "0.1.0" },
      });
      finishStatus?.({ paired: false, listenerRunning: true });
    });

    const row = (await screen.findByText("Browser use")).closest("li") as HTMLElement;
    expect(await within(row).findByText("Connected")).toBeInTheDocument();
    expect(within(row).queryByText("Finish setup")).toBeNull();
  });

  it("presents connected services and Computer use together as plugins", async () => {
    render(<ConnectorsSection />);

    expect(screen.getByRole("heading", { name: "Plugins" })).toBeInTheDocument();
    expect(screen.getByText("Computer use")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Connect Google" })).toBeEnabled();
  });

  it("uses plugin terminology for Obsidian status errors", async () => {
    mocks.obsidianStatus.mockRejectedValue(new Error("Could not read the saved vault"));

    render(<ConnectorsSection />);

    expect(await screen.findByLabelText("Obsidian plugin error")).toHaveTextContent(
      "Could not read the saved vault",
    );
  });

  it("blocks duplicate Obsidian picker opens and clears busy state after cancellation", async () => {
    let resolvePicker: (selection: string | null) => void = () => {};
    mocks.openFileDialog.mockReturnValue(
      new Promise((resolve) => {
        resolvePicker = resolve;
      }),
    );

    render(<ConnectorsSection />);
    const connect = await findEnabledConnect("Connect Obsidian");

    await userEvent.click(connect);
    expect(connect).toBeDisabled();
    await userEvent.click(connect);
    expect(mocks.openFileDialog).toHaveBeenCalledTimes(1);

    resolvePicker(null);
    await waitFor(() => expect(connect).toBeEnabled());
    expect(mocks.obsidianConfigure).not.toHaveBeenCalled();
  });

  it("connects an Obsidian vault without restarting Hermes", async () => {
    mocks.openFileDialog.mockResolvedValue("/vaults/work");
    mocks.obsidianStatus.mockResolvedValueOnce({ connected: false }).mockResolvedValue({
      connected: true,
      available: true,
      vaultPath: "/vaults/work",
      vaultName: "work",
    });

    render(<ConnectorsSection />);
    await userEvent.click(await findEnabledConnect("Connect Obsidian"));

    await waitFor(() => expect(mocks.obsidianConfigure).toHaveBeenCalledWith("/vaults/work"));
    expect(await screen.findByRole("button", { name: "Change Obsidian vault" })).toBeEnabled();
  });

  it("keeps a configured unavailable Obsidian vault visible and disconnectable", async () => {
    mocks.obsidianStatus.mockResolvedValue({
      connected: true,
      available: false,
      vaultPath: "/Volumes/External/Work",
      vaultName: "Work",
    });

    render(<ConnectorsSection />);

    expect(await screen.findByText("Vault unavailable")).toBeInTheDocument();
    expect(screen.getByText(/vault unavailable at \/Volumes\/External\/Work/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change Obsidian vault" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disconnect Obsidian" })).toBeEnabled();
  });

  it("shows immediate progress while disconnecting Obsidian", async () => {
    let finishDisconnect: () => void = () => {};
    mocks.obsidianStatus.mockResolvedValue({
      connected: true,
      available: true,
      vaultPath: "/vaults/work",
      vaultName: "work",
    });
    mocks.obsidianDisconnect.mockReturnValue(
      new Promise<void>((resolve) => {
        finishDisconnect = resolve;
      }),
    );

    render(<ConnectorsSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect Obsidian" }));

    const disconnecting = await screen.findByRole("button", { name: "Disconnect Obsidian" });
    expect(disconnecting).toBeDisabled();
    expect(disconnecting).toHaveTextContent("Disconnecting…");
    expect(disconnecting).toHaveAttribute("aria-busy", "true");

    finishDisconnect();
    await waitFor(() => expect(mocks.obsidianDisconnect).toHaveBeenCalledTimes(1));
  });

  it("lists Google with a capability blurb", async () => {
    render(<ConnectorsSection />);
    await findEnabledConnect("Connect Google");

    expect(screen.getByText("Google")).toBeInTheDocument();
    expect(screen.getByText(/mail and calendar for briefings/i)).toBeInTheDocument();
  });

  it("renders both provider rows", async () => {
    render(<ConnectorsSection />);
    await findEnabledConnect("Connect Google");

    expect(screen.getByText("Google")).toBeInTheDocument();
    expect(screen.getByText("Linear")).toBeInTheDocument();
    expect(await findEnabledConnect("Connect Linear")).toBeInTheDocument();
    expect(screen.getByText(/projects, cycles, and issues/i)).toBeInTheDocument();
  });

  it("qualifies local connector privacy with the model inference path", async () => {
    render(<ConnectorsSection />);
    await findEnabledConnect("Connect Google");

    expect(screen.getByText(/plugin content.*goes to your chosen model provider/i)).toBeVisible();
    expect(screen.queryByText(/OpenSoftware's servers cannot read your data/i)).toBeNull();
  });

  it("lists Notion as a connectable connector", async () => {
    render(<ConnectorsSection />);

    const connect = await findEnabledConnect("Connect Notion");
    expect(screen.getByText("Notion")).toBeInTheDocument();
    expect(screen.queryByText("Preview")).toBeNull();
    expect(
      screen.getByText(/Pages and workspace content for briefs, search, and approved updates/i),
    ).toBeInTheDocument();
    await userEvent.hover(screen.getByRole("button", { name: "Notion privacy and access scope" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      /Access may extend beyond selected pages/i,
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      /Search may include Notion-connected sources/i,
    );

    await userEvent.click(connect);

    expect(mocks.notionConnectorConnect).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Connect Notion" })).toBeInTheDocument();
    expect(
      screen.getByText(/You'll sign in to Notion and approve June's access/i),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/Access may extend beyond selected pages/i).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.getAllByText(/Search may include Notion-connected sources/i).length,
    ).toBeGreaterThanOrEqual(2);

    // The (i) button's aria-describedby must resolve to exactly one element
    // containing both disclosure strings, so screen readers encounter the
    // caveat when navigating the row.
    const infoButton = screen.getByRole("button", { name: "Notion privacy and access scope" });
    const describedById = infoButton.getAttribute("aria-describedby");
    expect(describedById).toBe("notion-scope-disclosure");
    const describedByTarget = document.getElementById("notion-scope-disclosure");
    expect(describedByTarget).not.toBeNull();
    expect(describedByTarget).toHaveTextContent(/Access may extend beyond selected pages/i);
    expect(describedByTarget).toHaveTextContent(/Search may include Notion-connected sources/i);

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(mocks.notionConnectorConnect).toHaveBeenCalled());
    expect(mocks.connectorsConnect).not.toHaveBeenCalled();
  });

  it("keeps the Notion dialog open and shows an error when OAuth fails", async () => {
    mocks.notionConnectorConnect.mockRejectedValue(new Error("OAuth rejected"));
    render(<ConnectorsSection />);

    await userEvent.click(await findEnabledConnect("Connect Notion"));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(mocks.notionConnectorConnect).toHaveBeenCalled());
    // Dialog stays open after an OAuth failure so the user can retry.
    expect(screen.getByRole("dialog", { name: "Connect Notion" })).toBeInTheDocument();
  });

  it("shows connected Notion preview state and disconnects locally", async () => {
    mocks.connectorsList.mockResolvedValue([
      {
        accountId: "notion-hosted-mcp",
        provider: "notion",
        email: "Notion",
        scopes: [],
        status: "connected",
        workspaceName: null,
        workspaceUrlKey: null,
        selectedTeams: [],
      },
    ]);
    render(<ConnectorsSection />);

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/Pages, search, and approved updates/i)).toBeInTheDocument();
    await userEvent.hover(screen.getByRole("button", { name: "Notion privacy and access scope" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      /Access may extend beyond selected pages/i,
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      /Search may include Notion-connected sources/i,
    );

    mocks.connectorsList.mockResolvedValue([]);
    await userEvent.click(screen.getByRole("button", { name: "Disconnect Notion" }));

    await waitFor(() => expect(mocks.notionConnectorDisconnect).toHaveBeenCalled());
    expect(await findEnabledConnect("Connect Notion")).toBeInTheDocument();
  });

  it("offers Notion reconnect when its grant is revoked", async () => {
    mocks.connectorsList.mockResolvedValue([
      {
        accountId: "notion-hosted-mcp",
        provider: "notion",
        email: "Notion",
        scopes: [],
        status: "reconnect_required",
        workspaceName: null,
        workspaceUrlKey: null,
        selectedTeams: [],
      },
    ]);
    render(<ConnectorsSection />);

    expect(await screen.findByText("Reconnect needed")).toBeInTheDocument();
    expect(
      screen.getByText(/Reconnect Notion to restore pages, search, and approved updates/i),
    ).toBeInTheDocument();
    await userEvent.hover(screen.getByRole("button", { name: "Notion privacy and access scope" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      /Access may extend beyond selected pages/i,
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      /Search may include Notion-connected sources/i,
    );
    await userEvent.click(screen.getByRole("button", { name: "Reconnect Notion" }));
    expect(mocks.notionConnectorConnect).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Reconnect Notion" })).toBeInTheDocument();
    expect(
      screen.getByText(/You'll sign in to Notion and approve June's access/i),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/Access may extend beyond selected pages/i).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.getAllByText(/Search may include Notion-connected sources/i).length,
    ).toBeGreaterThanOrEqual(2);

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(mocks.notionConnectorConnect).toHaveBeenCalled());
  });

  it("allows disconnect recovery when Notion status is unavailable", async () => {
    mocks.connectorsList.mockResolvedValue([
      {
        accountId: "notion-hosted-mcp",
        provider: "notion",
        email: "Notion",
        scopes: [],
        status: "unavailable",
        workspaceName: null,
        workspaceUrlKey: null,
        selectedTeams: [],
      },
    ]);
    render(<ConnectorsSection />);

    expect(await screen.findByText("Status unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("June could not confirm the Notion connection. Try again in a moment."),
    ).toBeInTheDocument();
    await userEvent.hover(screen.getByRole("button", { name: "Notion privacy and access scope" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      /Access may extend beyond selected pages/i,
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      /Search may include Notion-connected sources/i,
    );
    expect(screen.queryByRole("button", { name: "Connect Notion" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect Notion" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect Notion" }));

    await waitFor(() => expect(mocks.notionConnectorDisconnect).toHaveBeenCalled());
    expect(mocks.connectorsApplyRuntime).toHaveBeenCalled();
    expect(mocks.notionConnectorConnect).not.toHaveBeenCalled();
  });

  it("disables Notion disconnect while reconnect waits for the browser", async () => {
    mocks.connectorsList.mockResolvedValue([
      {
        accountId: "notion-hosted-mcp",
        provider: "notion",
        email: "Notion",
        scopes: [],
        status: "reconnect_required",
        workspaceName: null,
        workspaceUrlKey: null,
        selectedTeams: [],
      },
    ]);
    mocks.notionConnectorConnect.mockReturnValue(new Promise(() => {}));
    render(<ConnectorsSection />);

    await userEvent.click(await screen.findByRole("button", { name: "Reconnect Notion" }));

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reconnect Notion" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Disconnect Notion" })).toBeDisabled();
  });

  it("does not start Notion disconnect while reconnect waits for the browser", async () => {
    mocks.connectorsList.mockResolvedValue([
      {
        accountId: "notion-hosted-mcp",
        provider: "notion",
        email: "Notion",
        scopes: [],
        status: "reconnect_required",
        workspaceName: null,
        workspaceUrlKey: null,
        selectedTeams: [],
      },
    ]);
    mocks.notionConnectorConnect.mockReturnValue(new Promise(() => {}));
    render(<ConnectorsSection />);

    await userEvent.click(await screen.findByRole("button", { name: "Reconnect Notion" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect Notion" }));

    expect(mocks.notionConnectorDisconnect).not.toHaveBeenCalled();
  });

  it("does not start Notion reconnect while disconnect waits for runtime apply", async () => {
    mocks.connectorsList.mockResolvedValue([
      {
        accountId: "notion-hosted-mcp",
        provider: "notion",
        email: "Notion",
        scopes: [],
        status: "reconnect_required",
        workspaceName: null,
        workspaceUrlKey: null,
        selectedTeams: [],
      },
    ]);
    mocks.notionConnectorDisconnect.mockReturnValue(new Promise(() => {}));
    render(<ConnectorsSection />);

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect Notion" }));
    await userEvent.click(screen.getByRole("button", { name: "Reconnect Notion" }));

    expect(mocks.notionConnectorConnect).not.toHaveBeenCalled();
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
    expect(screen.getByText(/Connect apps and services in local mode/i)).toBeInTheDocument();
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
        provider: "google",
      }),
    );
    await waitFor(() => expect(mocks.connectorsApplyRuntime).toHaveBeenCalled());
    expect(await screen.findByText(/alex@example\.com/)).toBeInTheDocument();
  });

  it("cancels an in-flight connect and closes the dialog while waiting for the browser", async () => {
    // Hold the connect pending so the dialog stays in the "Waiting for
    // browser…" state, where Cancel must abort the backend loopback wait
    // rather than being inert.
    let rejectConnect: (reason: unknown) => void = () => {};
    mocks.connectorsConnect.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectConnect = reject;
      }),
    );

    render(<ConnectorsSection />);
    await userEvent.click(await findEnabledConnect("Connect Google"));
    const dialog = screen.getByRole("dialog", { name: "Connect Google account" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    // In the waiting state: the primary button reflects it, and Cancel stays
    // clickable.
    await within(dialog).findByRole("button", { name: /waiting for browser/i });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toBeEnabled();

    await userEvent.click(cancel);
    // The backend loopback wait is aborted and the dialog closes.
    await waitFor(() => expect(mocks.connectorsCancelConnect).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Connect Google account" })).toBeNull(),
    );

    // The backend then rejects the awaited connect with the cancel code; that
    // is expected and must not surface an error toast.
    rejectConnect({ code: "connector_connect_canceled", message: "canceled" });
    expect(screen.queryByText(/canceled/i)).toBeNull();
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

    expect(await screen.findByText("Google isn't configured in this build.")).toBeInTheDocument();
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
        provider: "google",
      }),
    );
    await waitFor(() => expect(mocks.connectorsApplyRuntime).toHaveBeenCalled());
  });

  it("revokes by default so a disconnect cannot orphan the grant", async () => {
    mocks.connectorsList.mockResolvedValue([account()]);
    render(<ConnectorsSection />);
    await screen.findByText(/alex@example\.com/);

    await userEvent.click(screen.getByRole("button", { name: "Disconnect Google" }));
    const dialog = await screen.findByRole("dialog", { name: /Disconnect alex@example.com/ });
    // Checked on open: a disconnect that leaves the grant alive also drops
    // June's tokens, so the user could never revoke it from June afterward.
    expect(
      within(dialog).getByRole("checkbox", { name: /revoke June's access with Google/i }),
    ).toBeChecked();

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

  it("still allows opting out of the provider-side revoke", async () => {
    mocks.connectorsList.mockResolvedValue([account()]);
    render(<ConnectorsSection />);
    await screen.findByText(/alex@example\.com/);

    await userEvent.click(screen.getByRole("button", { name: "Disconnect Google" }));
    const dialog = await screen.findByRole("dialog", { name: /Disconnect alex@example.com/ });
    // Unchecking is a deliberate "I'll reconnect shortly" choice.
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: /revoke June's access with Google/i }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() =>
      expect(mocks.connectorsDisconnect).toHaveBeenCalledWith({
        accountId: "acc-1",
        revoke: false,
      }),
    );
  });
});

describe("ConnectorsSection — Linear", () => {
  it("connects a workspace, applies the runtime, and auto-opens team selection", async () => {
    mocks.connectorsConnect.mockResolvedValue(linearAccount({ selectedTeams: [] }));
    render(<ConnectorsSection />);

    await userEvent.click(await findEnabledConnect("Connect Linear"));
    const dialog = screen.getByRole("dialog", { name: "Connect Linear workspace" });
    expect(within(dialog).getByRole("checkbox", { name: /read workspace/i })).toBeChecked();
    expect(
      within(dialog).getByRole("checkbox", { name: /create and update issues/i }),
    ).not.toBeChecked();

    mocks.connectorsList.mockResolvedValue([linearAccount({ selectedTeams: [] })]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(mocks.connectorsConnect).toHaveBeenCalledWith({
        scopes: ["linear_read"],
        loginHint: undefined,
        provider: "linear",
      }),
    );
    // Slice 2 registers the june_linear MCP server, so a Linear connect now
    // needs a runtime apply just like Google — registering a server name is
    // a config-render change.
    await waitFor(() => expect(mocks.connectorsApplyRuntime).toHaveBeenCalled());

    const teamsDialog = await screen.findByRole("dialog", { name: "Select Linear teams" });
    await waitFor(() =>
      expect(mocks.connectorsLinearTeams).toHaveBeenCalledWith({ accountId: "linear-acc-1" }),
    );
    // Nothing preselected on a first connect.
    expect(within(teamsDialog).getByRole("checkbox", { name: /engineering/i })).not.toBeChecked();
  });

  it("shows the unfinished-setup hint and a Select teams action when no teams are chosen yet", async () => {
    mocks.connectorsList.mockResolvedValue([linearAccount({ selectedTeams: [] })]);
    render(<ConnectorsSection />);

    expect(await screen.findByText("Select teams to finish setup")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select teams" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage teams" })).toBeNull();
  });

  it("disables Save teams until a team is checked, then saves the chosen teams", async () => {
    mocks.connectorsList.mockResolvedValue([linearAccount({ selectedTeams: [] })]);
    render(<ConnectorsSection />);
    await screen.findByText("Select teams to finish setup");

    await userEvent.click(screen.getByRole("button", { name: "Select teams" }));
    const dialog = await screen.findByRole("dialog", { name: "Select Linear teams" });
    await waitFor(() => expect(mocks.connectorsLinearTeams).toHaveBeenCalled());

    const saveButton = within(dialog).getByRole("button", { name: "Save teams" });
    expect(saveButton).toBeDisabled();

    await userEvent.click(within(dialog).getByRole("checkbox", { name: /engineering/i }));
    expect(saveButton).toBeEnabled();

    mocks.connectorsList.mockResolvedValue([linearAccount({ selectedTeams: [TEAM_ENG] })]);
    await userEvent.click(saveButton);

    await waitFor(() =>
      expect(mocks.connectorsSetSelectedTeams).toHaveBeenCalledWith({
        accountId: "linear-acc-1",
        teams: [TEAM_ENG],
      }),
    );
    expect(await screen.findByText(/1 team selected/i)).toBeInTheDocument();
    // This save crossed the registration boundary (zero teams before it),
    // which is what lets june_linear register at all - so it must apply the
    // runtime.
    expect(mocks.connectorsApplyRuntime).toHaveBeenCalled();
  });

  it("skips the runtime apply when a teams edit does not cross the registration boundary", async () => {
    mocks.connectorsList.mockResolvedValue([linearAccount({ selectedTeams: [TEAM_ENG] })]);
    mocks.connectorsSetSelectedTeams.mockResolvedValue(
      linearAccount({ selectedTeams: [TEAM_ENG, TEAM_DESIGN] }),
    );
    render(<ConnectorsSection />);
    await screen.findByText(/1 team selected/i);

    await userEvent.click(screen.getByRole("button", { name: "Manage teams" }));
    const dialog = await screen.findByRole("dialog", { name: "Select Linear teams" });
    await waitFor(() => expect(mocks.connectorsLinearTeams).toHaveBeenCalled());

    await userEvent.click(within(dialog).getByRole("checkbox", { name: /design/i }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save teams" }));

    await waitFor(() => expect(mocks.connectorsSetSelectedTeams).toHaveBeenCalled());
    // The server was already registered (a team was selected before this
    // edit); the grant change is enforced per-request in Rust, so no
    // restart.
    expect(mocks.connectorsApplyRuntime).not.toHaveBeenCalled();
  });

  it("retries a failed first-team runtime apply after the account refreshes", async () => {
    const selectedAccount = linearAccount({ selectedTeams: [TEAM_ENG] });
    mocks.connectorsList.mockResolvedValue([linearAccount({ selectedTeams: [] })]);
    mocks.connectorsApplyRuntime
      .mockRejectedValueOnce({ message: "Runtime apply failed" })
      .mockResolvedValueOnce(undefined);
    mocks.connectorsSetSelectedTeams.mockImplementation(async () => {
      mocks.connectorsList.mockResolvedValue([selectedAccount]);
      connectorsChangedListener?.();
      return selectedAccount;
    });

    render(<ConnectorsSection />);
    await screen.findByText("Select teams to finish setup");
    await userEvent.click(screen.getByRole("button", { name: "Select teams" }));
    const dialog = await screen.findByRole("dialog", { name: "Select Linear teams" });
    await userEvent.click(await within(dialog).findByRole("checkbox", { name: /engineering/i }));
    const saveButton = within(dialog).getByRole("button", { name: "Save teams" });

    await userEvent.click(saveButton);
    await waitFor(() => expect(mocks.connectorsApplyRuntime).toHaveBeenCalledTimes(1));
    expect(dialog).toBeInTheDocument();
    await screen.findByText(/1 team selected/i);

    await userEvent.click(saveButton);
    await waitFor(() => expect(mocks.connectorsApplyRuntime).toHaveBeenCalledTimes(2));
  });

  it("preselects the account's current teams when managing teams", async () => {
    mocks.connectorsList.mockResolvedValue([linearAccount({ selectedTeams: [TEAM_ENG] })]);
    render(<ConnectorsSection />);
    await screen.findByText(/1 team selected/i);

    await userEvent.click(screen.getByRole("button", { name: "Manage teams" }));
    const dialog = await screen.findByRole("dialog", { name: "Select Linear teams" });
    await waitFor(() => expect(mocks.connectorsLinearTeams).toHaveBeenCalled());

    expect(within(dialog).getByRole("checkbox", { name: /engineering/i })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: /design/i })).not.toBeChecked();
  });

  it("shows an error with a retry when the team list fails to load", async () => {
    mocks.connectorsList.mockResolvedValue([linearAccount({ selectedTeams: [TEAM_ENG] })]);
    mocks.connectorsLinearTeams.mockRejectedValueOnce({ message: "Linear is unreachable" });
    render(<ConnectorsSection />);
    await screen.findByText(/1 team selected/i);

    await userEvent.click(screen.getByRole("button", { name: "Manage teams" }));
    const dialog = await screen.findByRole("dialog", { name: "Select Linear teams" });

    expect(await within(dialog).findByText("Linear is unreachable")).toBeInTheDocument();
    mocks.connectorsLinearTeams.mockResolvedValueOnce({
      teams: [TEAM_ENG, TEAM_DESIGN],
      truncated: false,
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));

    expect(await within(dialog).findByRole("checkbox", { name: /engineering/i })).toBeChecked();
  });

  it("keeps a selected team the live listing no longer returns", async () => {
    // TEAM_ENG is persisted as selected but absent from the live fetch
    // (archived, hidden, or beyond the pagination cap). It must stay
    // visible, stay checked, and survive an unrelated save untouched.
    mocks.connectorsList.mockResolvedValue([linearAccount({ selectedTeams: [TEAM_ENG] })]);
    mocks.connectorsLinearTeams.mockResolvedValue({ teams: [TEAM_DESIGN], truncated: false });
    render(<ConnectorsSection />);
    await screen.findByText(/1 team selected/i);

    await userEvent.click(screen.getByRole("button", { name: "Manage teams" }));
    const dialog = await screen.findByRole("dialog", { name: "Select Linear teams" });

    const stale = await within(dialog).findByRole("checkbox", { name: /engineering/i });
    expect(stale).toBeChecked();
    expect(within(dialog).getByText(/not visible in Linear right now/i)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("checkbox", { name: /design/i }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save teams" }));

    await waitFor(() =>
      expect(mocks.connectorsSetSelectedTeams).toHaveBeenCalledWith({
        accountId: "linear-acc-1",
        teams: [TEAM_DESIGN, TEAM_ENG],
      }),
    );
  });

  it("flags a truncated team listing instead of presenting it as complete", async () => {
    mocks.connectorsList.mockResolvedValue([linearAccount({ selectedTeams: [TEAM_ENG] })]);
    mocks.connectorsLinearTeams.mockResolvedValue({
      teams: [TEAM_ENG, TEAM_DESIGN],
      truncated: true,
    });
    render(<ConnectorsSection />);
    await screen.findByText(/1 team selected/i);

    await userEvent.click(screen.getByRole("button", { name: "Manage teams" }));
    const dialog = await screen.findByRole("dialog", { name: "Select Linear teams" });

    expect(await within(dialog).findByText(/only the first 500 teams/i)).toBeInTheDocument();
  });

  it("reconnects a workspace using the account id as the login hint", async () => {
    mocks.connectorsList.mockResolvedValue([
      linearAccount({ status: "reconnect_required", selectedTeams: [TEAM_ENG] }),
    ]);
    mocks.connectorsConnect.mockResolvedValue(linearAccount({ selectedTeams: [TEAM_ENG] }));
    render(<ConnectorsSection />);
    await screen.findByText(/Acme/);

    await userEvent.click(screen.getByRole("button", { name: "Reconnect Linear" }));

    await waitFor(() =>
      expect(mocks.connectorsConnect).toHaveBeenCalledWith({
        scopes: ["linear_read"],
        loginHint: "linear-acc-1",
        provider: "linear",
      }),
    );
    // A reconnect goes through the same runConnect path as a fresh connect,
    // so it applies the runtime too.
    await waitFor(() => expect(mocks.connectorsApplyRuntime).toHaveBeenCalled());
  });
});

function githubAccount(overrides: Partial<ConnectorAccount> = {}): ConnectorAccount {
  return {
    accountId: "12345678",
    provider: "github",
    email: "octocat",
    scopes: ["read"],
    status: "connected",
    workspaceName: null,
    workspaceUrlKey: null,
    selectedTeams: [],
    ...overrides,
  };
}

describe("ConnectorsSection — GitHub", () => {
  it("renders GitHub in the provider directory with its capability blurb", async () => {
    render(<ConnectorsSection />);
    await findEnabledConnect("Connect GitHub");

    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText(/read issues, pull requests, and code/i)).toBeInTheDocument();
  });

  it("connects with github_read by default and applies the runtime", async () => {
    mocks.connectorsConnect.mockResolvedValue(githubAccount());
    render(<ConnectorsSection />);

    await userEvent.click(await findEnabledConnect("Connect GitHub"));
    const dialog = screen.getByRole("dialog", { name: "Connect GitHub account" });
    expect(
      within(dialog).getByRole("checkbox", {
        name: /read repositories, issues, and pull requests/i,
      }),
    ).toBeChecked();
    expect(
      within(dialog).getByRole("checkbox", { name: /create and update issues and comments/i }),
    ).not.toBeChecked();

    mocks.connectorsList.mockResolvedValue([githubAccount()]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(mocks.connectorsConnect).toHaveBeenCalledWith({
        scopes: ["github_read"],
        loginHint: undefined,
        provider: "github",
      }),
    );
    await waitFor(() => expect(mocks.connectorsApplyRuntime).toHaveBeenCalled());
  });

  it("adds github_write when the write checkbox is checked", async () => {
    mocks.connectorsConnect.mockResolvedValue(githubAccount({ scopes: ["read", "write"] }));
    render(<ConnectorsSection />);

    await userEvent.click(await findEnabledConnect("Connect GitHub"));
    const dialog = screen.getByRole("dialog", { name: "Connect GitHub account" });
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: /create and update issues and comments/i }),
    );

    mocks.connectorsList.mockResolvedValue([githubAccount({ scopes: ["read", "write"] })]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(mocks.connectorsConnect).toHaveBeenCalledWith({
        scopes: ["github_read", "github_write"],
        loginHint: undefined,
        provider: "github",
      }),
    );
  });

  it("shows a connected GitHub account with the login as identity", async () => {
    mocks.connectorsList.mockResolvedValue([githubAccount()]);
    render(<ConnectorsSection />);

    expect(await screen.findByText(/octocat/)).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("shows read and write state in the connected account subtitle", async () => {
    mocks.connectorsList.mockResolvedValue([githubAccount({ scopes: ["read", "write"] })]);
    render(<ConnectorsSection />);

    // The subtitle includes feature labels from grantedFeatureLabels
    expect(await screen.findByText(/octocat/)).toBeInTheDocument();
    // Both read and write bundles are shown in the subtitle
    expect(
      screen.getByText(/read repositories, issues, and pull requests.*create and update issues/i),
    ).toBeInTheDocument();
  });

  it("shows reconnect_required state for a lapsed GitHub account", async () => {
    mocks.connectorsList.mockResolvedValue([githubAccount({ status: "reconnect_required" })]);
    render(<ConnectorsSection />);

    expect(await screen.findByText("Reconnect needed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect GitHub" })).toBeInTheDocument();
  });

  it("reconnects using the numeric account id as the login hint", async () => {
    mocks.connectorsList.mockResolvedValue([githubAccount({ status: "reconnect_required" })]);
    mocks.connectorsConnect.mockResolvedValue(githubAccount());
    render(<ConnectorsSection />);
    await screen.findByText("Reconnect needed");

    await userEvent.click(screen.getByRole("button", { name: "Reconnect GitHub" }));

    await waitFor(() =>
      expect(mocks.connectorsConnect).toHaveBeenCalledWith({
        scopes: ["github_read"],
        loginHint: "12345678",
        provider: "github",
      }),
    );
    await waitFor(() => expect(mocks.connectorsApplyRuntime).toHaveBeenCalled());
  });

  it("GitHub reconnect opens the dialog and device-code panel is visible when the event fires", async () => {
    // The regression test: device-code panel must render inside the dialog that
    // opens when the user clicks Reconnect — not outside it, and not only via
    // the manual Connect path.
    mocks.connectorsList.mockResolvedValue([githubAccount({ status: "reconnect_required" })]);
    mocks.connectorsConnect.mockReturnValue(new Promise(() => {}));
    render(<ConnectorsSection />);
    await screen.findByText("Reconnect needed");

    await userEvent.click(screen.getByRole("button", { name: "Reconnect GitHub" }));

    // The dialog opens immediately (before the user has to click anything else).
    const dialog = await screen.findByRole("dialog", { name: "Reconnect GitHub account" });
    // connectorsConnect is called automatically with the account's existing bundles and login hint.
    await waitFor(() =>
      expect(mocks.connectorsConnect).toHaveBeenCalledWith({
        scopes: ["github_read"],
        loginHint: "12345678",
        provider: "github",
      }),
    );

    // Fire the device-code event from the backend.
    act(() => {
      eventHandlers.get("june://connectors-github-device-code")?.({
        payload: {
          userCode: "RECON-5678",
          verificationUri: "https://github.com/login/device",
          expiresInSeconds: 900,
        },
      });
    });

    // The device-code panel is visible INSIDE the dialog (regression guard).
    expect(await within(dialog).findByText("RECON-5678")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/enter this code at github\.com\/login\/device to approve June/i),
    ).toBeInTheDocument();
  });

  it("GitHub reconnect + connector_github_device_expired shows retry copy inside the dialog", async () => {
    mocks.connectorsList.mockResolvedValue([githubAccount({ status: "reconnect_required" })]);
    let rejectConnect: (reason: unknown) => void = () => {};
    mocks.connectorsConnect.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectConnect = reject;
      }),
    );
    render(<ConnectorsSection />);
    await screen.findByText("Reconnect needed");

    await userEvent.click(screen.getByRole("button", { name: "Reconnect GitHub" }));

    const dialog = await screen.findByRole("dialog", { name: "Reconnect GitHub account" });

    // Simulate backend rejecting with expired code.
    act(() => rejectConnect({ code: "connector_github_device_expired", message: "expired" }));

    // The retry error notice appears inside the dialog.
    expect(
      await within(dialog).findByText(/the code expired before it was approved\. try again\./i),
    ).toBeInTheDocument();
    // The Connect button reappears for a retry.
    expect(within(dialog).getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  it("Linear reconnect does NOT open the connect dialog", async () => {
    mocks.connectorsList.mockResolvedValue([
      linearAccount({ status: "reconnect_required", selectedTeams: [TEAM_ENG] }),
    ]);
    mocks.connectorsConnect.mockResolvedValue(linearAccount({ selectedTeams: [TEAM_ENG] }));
    render(<ConnectorsSection />);
    await screen.findByText(/Acme/);

    await userEvent.click(screen.getByRole("button", { name: "Reconnect Linear" }));

    // No connect dialog should open for Linear reconnect.
    await waitFor(() => expect(mocks.connectorsConnect).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: /reconnect/i })).toBeNull();
    expect(screen.queryByRole("dialog", { name: /connect linear/i })).toBeNull();
  });

  it("shows no team management UI for GitHub", async () => {
    mocks.connectorsList.mockResolvedValue([githubAccount()]);
    render(<ConnectorsSection />);
    await screen.findByText(/octocat/);

    expect(screen.queryByRole("button", { name: "Select teams" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage teams" })).toBeNull();
    expect(screen.queryByText("Select teams to finish setup")).toBeNull();
  });

  it("disconnects a GitHub account with revoke and applies the runtime", async () => {
    mocks.connectorsList.mockResolvedValue([githubAccount()]);
    render(<ConnectorsSection />);
    await screen.findByText(/octocat/);

    await userEvent.click(screen.getByRole("button", { name: "Disconnect GitHub" }));
    const dialog = await screen.findByRole("dialog", { name: /Disconnect octocat/ });
    expect(
      within(dialog).getByRole("checkbox", { name: /revoke June's access with GitHub/i }),
    ).toBeChecked();

    mocks.connectorsList.mockResolvedValue([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() =>
      expect(mocks.connectorsDisconnect).toHaveBeenCalledWith({
        accountId: "12345678",
        revoke: true,
      }),
    );
    await waitFor(() => expect(mocks.connectorsApplyRuntime).toHaveBeenCalled());
    expect(await findEnabledConnect("Connect GitHub")).toBeInTheDocument();
  });

  it("shows the device code, verification link text, and copy button when the device-code event arrives", async () => {
    // Hold the connect pending so the device-code panel can be shown.
    mocks.connectorsConnect.mockReturnValue(new Promise(() => {}));
    render(<ConnectorsSection />);

    await userEvent.click(await findEnabledConnect("Connect GitHub"));
    const dialog = screen.getByRole("dialog", { name: "Connect GitHub account" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    // Fire the device-code event from the backend.
    act(() => {
      eventHandlers.get("june://connectors-github-device-code")?.({
        payload: {
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          expiresInSeconds: 900,
        },
      });
    });

    // The device-code panel replaces the bundle picker.
    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    expect(
      screen.getByText(/enter this code at github\.com\/login\/device to approve June/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/waiting for approval on GitHub/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy code/i })).toBeInTheDocument();
    // The bundle checkboxes must not be visible.
    expect(screen.queryByRole("checkbox", { name: /read repositories/i })).toBeNull();
  });

  it("replaces the first device code with a second one when the event fires again", async () => {
    mocks.connectorsConnect.mockReturnValue(new Promise(() => {}));
    render(<ConnectorsSection />);

    await userEvent.click(await findEnabledConnect("Connect GitHub"));
    const dialog = screen.getByRole("dialog", { name: "Connect GitHub account" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    act(() => {
      eventHandlers.get("june://connectors-github-device-code")?.({
        payload: {
          userCode: "FIRST-111",
          verificationUri: "https://github.com/login/device",
          expiresInSeconds: 900,
        },
      });
    });
    expect(await screen.findByText("FIRST-111")).toBeInTheDocument();

    act(() => {
      eventHandlers.get("june://connectors-github-device-code")?.({
        payload: {
          userCode: "SECOND-222",
          verificationUri: "https://github.com/login/device",
          expiresInSeconds: 900,
        },
      });
    });

    expect(await screen.findByText("SECOND-222")).toBeInTheDocument();
    expect(screen.queryByText("FIRST-111")).toBeNull();
  });

  it("swaps to the connected toast path when connectorsConnect resolves", async () => {
    let resolveConnect: (value: ReturnType<typeof githubAccount>) => void = () => {};
    mocks.connectorsConnect.mockReturnValue(
      new Promise((resolve) => {
        resolveConnect = resolve;
      }),
    );
    render(<ConnectorsSection />);

    await userEvent.click(await findEnabledConnect("Connect GitHub"));
    const dialog = screen.getByRole("dialog", { name: "Connect GitHub account" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    // Fire device code so the panel shows up.
    act(() => {
      eventHandlers.get("june://connectors-github-device-code")?.({
        payload: {
          userCode: "ABCD-9999",
          verificationUri: "https://github.com/login/device",
          expiresInSeconds: 900,
        },
      });
    });
    expect(await screen.findByText("ABCD-9999")).toBeInTheDocument();

    // Now approve — resolve the connect.
    mocks.connectorsList.mockResolvedValue([githubAccount()]);
    act(() => resolveConnect(githubAccount()));

    // Dialog closes and a success toast fires.
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("GitHub account connected"),
    );
    expect(screen.queryByRole("dialog", { name: "Connect GitHub account" })).toBeNull();
    expect(await screen.findByText(/octocat/)).toBeInTheDocument();
  });

  it("shows expired-code retry copy when connectorsConnect rejects with connector_github_device_expired", async () => {
    let rejectConnect: (reason: unknown) => void = () => {};
    mocks.connectorsConnect.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectConnect = reject;
      }),
    );
    render(<ConnectorsSection />);

    await userEvent.click(await findEnabledConnect("Connect GitHub"));
    const dialog = screen.getByRole("dialog", { name: "Connect GitHub account" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    act(() => {
      eventHandlers.get("june://connectors-github-device-code")?.({
        payload: {
          userCode: "EXPIRING-1",
          verificationUri: "https://github.com/login/device",
          expiresInSeconds: 900,
        },
      });
    });
    expect(await screen.findByText("EXPIRING-1")).toBeInTheDocument();

    act(() => rejectConnect({ code: "connector_github_device_expired", message: "expired" }));

    // Bundle picker reappears with the retry error notice.
    expect(
      await screen.findByText(/the code expired before it was approved\. try again\./i),
    ).toBeInTheDocument();
    expect(screen.queryByText("EXPIRING-1")).toBeNull();
    // The Connect button is available again for retry.
    expect(within(dialog).getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  it("never renders the device-code panel in the Google connect dialog", async () => {
    mocks.connectorsConnect.mockReturnValue(new Promise(() => {}));
    render(<ConnectorsSection />);

    await userEvent.click(await findEnabledConnect("Connect Google"));
    const dialog = screen.getByRole("dialog", { name: "Connect Google account" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    // Fire a device-code event — must be silently ignored for Google.
    act(() => {
      eventHandlers.get("june://connectors-github-device-code")?.({
        payload: {
          userCode: "SHOULD-NOT-SHOW",
          verificationUri: "https://github.com/login/device",
          expiresInSeconds: 900,
        },
      });
    });

    // The Google dialog body keeps the bundle checkboxes; no device code.
    await waitFor(() =>
      expect(within(dialog).getByRole("checkbox", { name: /read mail/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText("SHOULD-NOT-SHOW")).toBeNull();
  });

  it("never renders the device-code panel in the Linear connect dialog", async () => {
    mocks.connectorsConnect.mockReturnValue(new Promise(() => {}));
    render(<ConnectorsSection />);

    await userEvent.click(await findEnabledConnect("Connect Linear"));
    const dialog = screen.getByRole("dialog", { name: "Connect Linear workspace" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    act(() => {
      eventHandlers.get("june://connectors-github-device-code")?.({
        payload: {
          userCode: "SHOULD-NOT-SHOW",
          verificationUri: "https://github.com/login/device",
          expiresInSeconds: 900,
        },
      });
    });

    await waitFor(() =>
      expect(within(dialog).getByRole("checkbox", { name: /read workspace/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText("SHOULD-NOT-SHOW")).toBeNull();
  });
});
