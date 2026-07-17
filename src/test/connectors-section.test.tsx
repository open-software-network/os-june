import { render, screen, waitFor, within } from "@testing-library/react";
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
  connectorsLinearTeams: vi.fn(),
  connectorsSetSelectedTeams: vi.fn(),
  obsidianStatus: vi.fn(),
  obsidianConfigure: vi.fn(),
  obsidianDisconnect: vi.fn(),
  obsidianApplyRuntime: vi.fn(),
  openFileDialog: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  connectorsList: mocks.connectorsList,
  connectorsConnect: mocks.connectorsConnect,
  connectorsCancelConnect: mocks.connectorsCancelConnect,
  connectorsDisconnect: mocks.connectorsDisconnect,
  connectorsApplyRuntime: mocks.connectorsApplyRuntime,
  connectorsLinearTeams: mocks.connectorsLinearTeams,
  connectorsSetSelectedTeams: mocks.connectorsSetSelectedTeams,
  obsidianStatus: mocks.obsidianStatus,
  obsidianConfigure: mocks.obsidianConfigure,
  obsidianDisconnect: mocks.obsidianDisconnect,
  obsidianApplyRuntime: mocks.obsidianApplyRuntime,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.openFileDialog,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";

const TEAM_ENG: LinearTeam = { id: "team-eng", key: "ENG", name: "Engineering" };
const TEAM_DESIGN: LinearTeam = { id: "team-design", key: "DES", name: "Design" };
let connectorsChangedListener: (() => void) | null = null;

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
  mocks.obsidianStatus.mockResolvedValue({ connected: false });
  mocks.obsidianConfigure.mockResolvedValue({
    connected: true,
    vaultPath: "/vaults/work",
    vaultName: "work",
  });
  mocks.obsidianDisconnect.mockResolvedValue({ connected: false });
  mocks.obsidianApplyRuntime.mockResolvedValue(undefined);
  mocks.openFileDialog.mockResolvedValue(null);
  mocks.listen.mockImplementation(async (_event: string, handler: () => void) => {
    connectorsChangedListener = handler;
    return () => {};
  });
});

/** Waits for the initial connectorsList load to settle. */
async function findEnabledConnect(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

describe("ConnectorsSection", () => {
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
    expect(mocks.obsidianApplyRuntime).not.toHaveBeenCalled();
  });

  it("connects an Obsidian vault and applies it to the runtime", async () => {
    mocks.openFileDialog.mockResolvedValue("/vaults/work");
    mocks.obsidianStatus
      .mockResolvedValueOnce({ connected: false })
      .mockResolvedValue({ connected: true, vaultPath: "/vaults/work", vaultName: "work" });

    render(<ConnectorsSection />);
    await userEvent.click(await findEnabledConnect("Connect Obsidian"));

    await waitFor(() => expect(mocks.obsidianConfigure).toHaveBeenCalledWith("/vaults/work"));
    await waitFor(() => expect(mocks.obsidianApplyRuntime).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Change Obsidian vault" })).toBeEnabled();
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

    expect(
      screen.getByText(/connector content.*goes to your chosen model provider/i),
    ).toBeVisible();
    expect(screen.queryByText(/OpenSoftware's servers cannot read your data/i)).toBeNull();
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
    expect(screen.getByText(/Connect Google and Linear in local mode/i)).toBeInTheDocument();
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
