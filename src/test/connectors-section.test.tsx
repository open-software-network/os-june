import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsSection } from "../components/settings/ConnectorsSection";
import type { ConnectorAccount, GitHubConnection } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  connectorsList: vi.fn<() => Promise<ConnectorAccount[]>>(),
  connectorsConnect: vi.fn(),
  connectorsDisconnect: vi.fn(),
  connectorsApplyRuntime: vi.fn(),
  githubConnectionGet: vi.fn<() => Promise<GitHubConnection | null>>(),
  listen: vi.fn(),
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  connectorsList: mocks.connectorsList,
  connectorsConnect: mocks.connectorsConnect,
  connectorsDisconnect: mocks.connectorsDisconnect,
  connectorsApplyRuntime: mocks.connectorsApplyRuntime,
  githubConnectionGet: mocks.githubConnectionGet,
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

function githubConnection(overrides: Partial<GitHubConnection> = {}): GitHubConnection {
  return {
    githubUserId: "github-user-583231",
    login: "octocat",
    status: "connected",
    installations: [
      {
        installationId: "installation-octo-org",
        ownerId: "owner-octo-org",
        ownerLogin: "octo-org",
        ownerType: "Organization",
        repositorySelection: "selected",
        permissions: { contents: "read" },
        repositories: [
          {
            repositoryId: "repository-alpha",
            installationId: "installation-octo-org",
            ownerLogin: "octo-org",
            name: "alpha",
            fullName: "octo-org/alpha",
            private: false,
            archived: false,
            permissions: { pull: true },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connectorsList.mockResolvedValue([]);
  mocks.connectorsConnect.mockResolvedValue(account());
  mocks.connectorsDisconnect.mockResolvedValue(undefined);
  mocks.connectorsApplyRuntime.mockResolvedValue(undefined);
  mocks.githubConnectionGet.mockResolvedValue(null);
  mocks.listen.mockResolvedValue(() => {});
});

/** Waits for the initial connectorsList load to settle. */
async function findEnabledConnect(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

describe("ConnectorsSection", () => {
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
    expect(screen.getByText(/Connect Google in local mode/i)).toBeInTheDocument();
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

  it("loads Google and GitHub in parallel and refreshes both from the shared event", async () => {
    const initialGoogle = deferred<ConnectorAccount[]>();
    const initialGitHub = deferred<GitHubConnection | null>();
    mocks.connectorsList.mockReturnValueOnce(initialGoogle.promise);
    mocks.githubConnectionGet.mockReturnValueOnce(initialGitHub.promise);

    render(<ConnectorsSection />);

    await waitFor(() => {
      expect(mocks.connectorsList).toHaveBeenCalledTimes(1);
      expect(mocks.githubConnectionGet).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      initialGoogle.resolve([account()]);
      initialGitHub.resolve(githubConnection());
      await Promise.all([initialGoogle.promise, initialGitHub.promise]);
    });

    expect(await screen.findByText(/alex@example\.com/)).toBeInTheDocument();
    expect(await screen.findByText("octocat · 1 repository")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add access" })).toBeInTheDocument();

    await waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(1));
    const onConnectorsChanged = mocks.listen.mock.calls[0]?.[1] as () => void;
    mocks.connectorsList.mockResolvedValueOnce([account({ email: "sam@example.com" })]);
    mocks.githubConnectionGet.mockResolvedValueOnce(
      githubConnection({ githubUserId: "github-user-729", login: "hubot" }),
    );
    await act(async () => onConnectorsChanged());

    expect(await screen.findByText(/sam@example\.com/)).toBeInTheDocument();
    expect(await screen.findByText("hubot · 1 repository")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add access" })).toBeInTheDocument();
    expect(mocks.connectorsList).toHaveBeenCalledTimes(2);
    expect(mocks.githubConnectionGet).toHaveBeenCalledTimes(2);
  });

  it("keeps Google visible when GitHub loading fails", async () => {
    mocks.connectorsList.mockResolvedValue([account()]);
    mocks.githubConnectionGet.mockRejectedValue({
      code: "github_refresh_failed",
      message: "raw GitHub provider body",
    });

    render(<ConnectorsSection />);

    expect(await screen.findByText(/alex@example\.com/)).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(
      screen.getByText("GitHub connection could not be loaded. Try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/raw GitHub provider body/)).toBeNull();
  });

  it("keeps GitHub visible when Google loading fails", async () => {
    mocks.connectorsList.mockRejectedValue({
      code: "connector_storage_failed",
      message: "raw Google storage detail",
    });
    mocks.githubConnectionGet.mockResolvedValue(githubConnection());

    render(<ConnectorsSection />);

    expect(await screen.findByText("octocat · 1 repository")).toBeInTheDocument();
    expect(await findEnabledConnect("Connect Google")).toBeInTheDocument();
    expect(screen.getByText("Google accounts could not be loaded. Try again.")).toBeInTheDocument();
    expect(screen.queryByText(/raw Google storage detail/)).toBeNull();
  });

  it("ignores a delayed old refresh after a newer refresh completes", async () => {
    const oldGoogle = deferred<ConnectorAccount[]>();
    const oldGitHub = deferred<GitHubConnection | null>();
    mocks.connectorsList
      .mockReturnValueOnce(oldGoogle.promise)
      .mockResolvedValueOnce([account({ email: "new@example.com" })]);
    mocks.githubConnectionGet
      .mockReturnValueOnce(oldGitHub.promise)
      .mockResolvedValueOnce(
        githubConnection({ githubUserId: "github-user-new", login: "new-login" }),
      );
    render(<ConnectorsSection />);

    await waitFor(() => {
      expect(mocks.connectorsList).toHaveBeenCalledTimes(1);
      expect(mocks.githubConnectionGet).toHaveBeenCalledTimes(1);
      expect(mocks.listen).toHaveBeenCalledTimes(1);
    });
    const onConnectorsChanged = mocks.listen.mock.calls[0]?.[1] as () => void;
    await act(async () => onConnectorsChanged());

    expect(await screen.findByText(/new@example\.com/)).toBeInTheDocument();
    expect(await screen.findByText("new-login · 1 repository")).toBeInTheDocument();

    await act(async () => {
      oldGoogle.resolve([account({ email: "old@example.com" })]);
      oldGitHub.resolve(githubConnection({ githubUserId: "github-user-old", login: "old-login" }));
      await Promise.all([oldGoogle.promise, oldGitHub.promise]);
    });

    expect(screen.getByText(/new@example\.com/)).toBeInTheDocument();
    expect(screen.getByText("new-login · 1 repository")).toBeInTheDocument();
    expect(screen.queryByText(/old@example\.com/)).toBeNull();
    expect(screen.queryByText(/old-login/)).toBeNull();
  });
});
