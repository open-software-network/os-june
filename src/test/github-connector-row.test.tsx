import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubConnectorRow } from "../components/settings/GitHubConnectorRow";
import type {
  GitHubConnection,
  GitHubDevicePrompt,
  GitHubInstallation,
  GitHubRepository,
} from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  githubConnectStart: vi.fn(),
  githubConnectWait: vi.fn(),
  githubConnectCancel: vi.fn(),
  githubInstallationsRefresh: vi.fn(),
  githubInstallationOpen: vi.fn(),
  githubDisconnect: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  githubConnectStart: mocks.githubConnectStart,
  githubConnectWait: mocks.githubConnectWait,
  githubConnectCancel: mocks.githubConnectCancel,
  githubInstallationsRefresh: mocks.githubInstallationsRefresh,
  githubInstallationOpen: mocks.githubInstallationOpen,
  githubDisconnect: mocks.githubDisconnect,
}));

const DEVICE_PROMPT: GitHubDevicePrompt = {
  userCode: "ABCD-EFGH",
  verificationUri: "https://github.com/login/device",
  expiresAtUnix: 1_800_000_000,
  intervalSeconds: 5,
};

function repository(name: string, overrides: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    repositoryId: `repository-${name}`,
    installationId: "installation-octo-org",
    ownerLogin: "octo-org",
    name,
    fullName: `octo-org/${name}`,
    private: false,
    archived: false,
    permissions: { pull: true },
    ...overrides,
  };
}

function installation(overrides: Partial<GitHubInstallation> = {}): GitHubInstallation {
  return {
    installationId: "installation-octo-org",
    ownerId: "owner-octo-org",
    ownerLogin: "octo-org",
    ownerType: "Organization",
    repositorySelection: "selected",
    permissions: { contents: "read" },
    repositories: [repository("alpha"), repository("legacy", { private: true, archived: true })],
    ...overrides,
  };
}

function connection(overrides: Partial<GitHubConnection> = {}): GitHubConnection {
  return {
    githubUserId: "github-user-583231",
    login: "octocat",
    avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
    status: "connected",
    installations: [
      installation(),
      installation({
        installationId: "installation-suspended-org",
        ownerId: "owner-suspended-org",
        ownerLogin: "suspended-org",
        suspendedAt: "2026-07-15T00:00:00Z",
        repositories: [],
      }),
    ],
    ...overrides,
  };
}

function StatefulRow({ initial }: { initial: GitHubConnection | null }) {
  const [current, setCurrent] = useState(initial);
  return (
    <GitHubConnectorRow connection={current} loading={false} onConnectionChanged={setCurrent} />
  );
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
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.writeText },
  });
  mocks.githubConnectStart.mockResolvedValue(DEVICE_PROMPT);
  mocks.githubConnectCancel.mockResolvedValue(undefined);
  mocks.githubInstallationsRefresh.mockResolvedValue(connection());
  mocks.githubInstallationOpen.mockResolvedValue(undefined);
  mocks.githubDisconnect.mockResolvedValue(undefined);
  mocks.writeText.mockResolvedValue(undefined);
});

describe("GitHubConnectorRow", () => {
  it("shows the GitHub capability blurb and Connect while disconnected", () => {
    render(<GitHubConnectorRow connection={null} loading={false} onConnectionChanged={vi.fn()} />);

    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText(/repository access/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeEnabled();
  });

  it("sanitizes a github_not_configured failure into an inline notice", async () => {
    mocks.githubConnectStart.mockRejectedValue({
      code: "github_not_configured",
      message: "GITHUB_APP_CLIENT_ID=do-not-render",
    });
    render(<GitHubConnectorRow connection={null} loading={false} onConnectionChanged={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));

    expect(await screen.findByText("GitHub is not configured for this build.")).toBeInTheDocument();
    expect(screen.queryByText(/GITHUB_APP_CLIENT_ID/)).toBeNull();
  });

  it("shows the device prompt and starts one authorization wait", async () => {
    const pending = deferred<GitHubConnection>();
    mocks.githubConnectWait.mockReturnValue(pending.promise);
    render(<GitHubConnectorRow connection={null} loading={false} onConnectionChanged={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));

    const dialog = await screen.findByRole("dialog", { name: "Connect GitHub" });
    expect(within(dialog).getByText("Enter this code on GitHub to authorize June.")).toBeVisible();
    expect(within(dialog).getByText("ABCD-EFGH")).toBeVisible();
    expect(within(dialog).getByText("Waiting for authorization...")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Copy code" })).toBeEnabled();
    expect(within(dialog).getByRole("link", { name: "Open GitHub" })).toHaveAttribute(
      "href",
      DEVICE_PROMPT.verificationUri,
    );
    expect(within(dialog).getByRole("link", { name: "Open GitHub" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(within(dialog).getByRole("link", { name: "Open GitHub" })).toHaveAttribute(
      "rel",
      "noreferrer",
    );
    expect(mocks.githubConnectStart).toHaveBeenCalledTimes(1);
    expect(mocks.githubConnectWait).toHaveBeenCalledTimes(1);
  });

  it("copies only the user code", async () => {
    const pending = deferred<GitHubConnection>();
    mocks.githubConnectWait.mockReturnValue(pending.promise);
    render(<GitHubConnectorRow connection={null} loading={false} onConnectionChanged={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect GitHub" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Copy code" }));

    expect(mocks.writeText).toHaveBeenCalledTimes(1);
    expect(mocks.writeText).toHaveBeenCalledWith("ABCD-EFGH");
  });

  it("cancels a closed device dialog and ignores a late wait result", async () => {
    const pending = deferred<GitHubConnection>();
    const onConnectionChanged = vi.fn();
    mocks.githubConnectWait.mockReturnValue(pending.promise);
    render(
      <GitHubConnectorRow
        connection={null}
        loading={false}
        onConnectionChanged={onConnectionChanged}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect GitHub" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(mocks.githubConnectCancel).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Connect GitHub" })).toBeNull();

    await act(async () => pending.resolve(connection()));
    expect(onConnectionChanged).not.toHaveBeenCalled();
  });

  it.each([
    ["github_connect_denied", "GitHub authorization was denied. Try again."],
    ["github_connect_expired", "The GitHub authorization code expired. Try again."],
    ["github_connect_canceled", "GitHub authorization was canceled. Try again."],
    ["github_rate_limited", "GitHub is temporarily rate limited. Try again later."],
    [
      "github_token_exchange_failed",
      "GitHub returned an invalid authorization response. Try again.",
    ],
  ])("sanitizes %s and allows retry", async (code, expectedMessage) => {
    mocks.githubConnectWait.mockRejectedValueOnce({
      code,
      message: "provider body with sensitive troubleshooting details",
    });
    render(<GitHubConnectorRow connection={null} loading={false} onConnectionChanged={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));

    expect(await screen.findByText(expectedMessage)).toBeInTheDocument();
    expect(screen.queryByText(/sensitive troubleshooting details/)).toBeNull();
    const retry = screen.getByRole("button", { name: "Connect GitHub" });
    expect(retry).toBeEnabled();

    const pending = deferred<GitHubConnection>();
    mocks.githubConnectWait.mockReturnValueOnce(pending.promise);
    await userEvent.click(retry);
    expect(await screen.findByRole("dialog", { name: "Connect GitHub" })).toBeInTheDocument();
    expect(mocks.githubConnectStart).toHaveBeenCalledTimes(2);
    expect(mocks.githubConnectWait).toHaveBeenCalledTimes(2);
  });

  it("uses a generic sanitized message for an unknown failure", async () => {
    mocks.githubConnectStart.mockRejectedValue({
      code: "unexpected_provider_failure",
      message: "raw provider body",
      access_token: "never-render-this",
    });
    render(<GitHubConnectorRow connection={null} loading={false} onConnectionChanged={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));

    expect(
      await screen.findByText("GitHub could not complete the connection. Try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/raw provider body|never-render-this/)).toBeNull();
  });

  it("cancels an in-flight flow on unmount and ignores its late result", async () => {
    const pending = deferred<GitHubConnection>();
    const onConnectionChanged = vi.fn();
    mocks.githubConnectWait.mockReturnValue(pending.promise);
    const { unmount } = render(
      <GitHubConnectorRow
        connection={null}
        loading={false}
        onConnectionChanged={onConnectionChanged}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    await screen.findByRole("dialog", { name: "Connect GitHub" });

    unmount();
    await waitFor(() => expect(mocks.githubConnectCancel).toHaveBeenCalledTimes(1));
    await act(async () => pending.resolve(connection()));

    expect(onConnectionChanged).not.toHaveBeenCalled();
  });

  it("shows setup-incomplete identity plus install and stable-id management actions", async () => {
    const setupIncomplete = connection({
      status: "setup_incomplete",
      installations: [installation({ repositories: [] })],
    });
    render(
      <GitHubConnectorRow
        connection={setupIncomplete}
        loading={false}
        onConnectionChanged={vi.fn()}
      />,
    );

    expect(screen.getByText("octocat · 0 repositories")).toBeInTheDocument();
    expect(screen.getByText("Setup incomplete")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Install GitHub App" }));
    await userEvent.click(screen.getByRole("button", { name: "Manage repositories for octo-org" }));

    expect(mocks.githubInstallationOpen).toHaveBeenCalledTimes(2);
    expect(mocks.githubInstallationOpen).toHaveBeenNthCalledWith(1);
    expect(mocks.githubInstallationOpen).toHaveBeenNthCalledWith(2, "installation-octo-org");
  });

  it("shows connected DTO details, labels, suspended state, and row actions", async () => {
    render(
      <GitHubConnectorRow
        connection={connection()}
        loading={false}
        onConnectionChanged={vi.fn()}
      />,
    );

    expect(screen.getByText("octocat · 2 repositories")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "octocat GitHub avatar" })).toHaveAttribute(
      "src",
      "https://avatars.githubusercontent.com/u/583231?v=4",
    );
    expect(screen.getByRole("button", { name: "Refresh GitHub repositories" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disconnect GitHub" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "View GitHub repositories" }));
    const dialog = screen.getByRole("dialog", { name: "GitHub repositories" });
    expect(within(dialog).getByText("octo-org")).toBeInTheDocument();
    expect(within(dialog).getByText("alpha")).toBeInTheDocument();
    expect(within(dialog).getByText("legacy")).toBeInTheDocument();
    expect(within(dialog).getByText("Private")).toBeInTheDocument();
    expect(within(dialog).getByText("Archived")).toBeInTheDocument();
    expect(within(dialog).getByText("suspended-org")).toBeInTheDocument();
    expect(within(dialog).getByText("Installation suspended")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Manage repositories for octo-org" }),
    ).toBeEnabled();
  });

  it("does not render an avatar from any other remote origin", () => {
    render(
      <GitHubConnectorRow
        connection={connection({ avatarUrl: "https://example.com/avatar.png" })}
        loading={false}
        onConnectionChanged={vi.fn()}
      />,
    );

    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows reconnect without presenting cached repositories as connected", () => {
    render(
      <GitHubConnectorRow
        connection={connection({ status: "reconnect_required" })}
        loading={false}
        onConnectionChanged={vi.fn()}
      />,
    );

    expect(screen.getByText("Reconnect required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect GitHub" })).toBeEnabled();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByRole("button", { name: "View GitHub repositories" })).toBeNull();
    expect(screen.queryByText("alpha")).toBeNull();
  });

  it("refreshes from Rust and removes repositories absent from the replacement DTO", async () => {
    const refreshed = connection({
      installations: [installation({ repositories: [repository("beta")] })],
    });
    mocks.githubInstallationsRefresh.mockResolvedValue(refreshed);
    render(<StatefulRow initial={connection()} />);
    await userEvent.click(screen.getByRole("button", { name: "View GitHub repositories" }));
    const dialog = screen.getByRole("dialog", { name: "GitHub repositories" });
    expect(within(dialog).getByText("alpha")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Refresh GitHub repositories" }));

    expect(await within(dialog).findByText("beta")).toBeInTheDocument();
    expect(within(dialog).queryByText("alpha")).toBeNull();
    expect(within(dialog).queryByText("legacy")).toBeNull();
    expect(mocks.githubInstallationsRefresh).toHaveBeenCalledTimes(1);
  });

  it("opens each installation using only its stable installation id", async () => {
    render(
      <GitHubConnectorRow
        connection={connection()}
        loading={false}
        onConnectionChanged={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "View GitHub repositories" }));

    await userEvent.click(screen.getByRole("button", { name: "Manage repositories for octo-org" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Manage repositories for suspended-org" }),
    );

    expect(mocks.githubInstallationOpen).toHaveBeenNthCalledWith(1, "installation-octo-org");
    expect(mocks.githubInstallationOpen).toHaveBeenNthCalledWith(2, "installation-suspended-org");
  });

  it("requires confirmation before disconnecting and returns to disconnected", async () => {
    render(<StatefulRow initial={connection()} />);

    await userEvent.click(screen.getByRole("button", { name: "Disconnect GitHub" }));
    expect(mocks.githubDisconnect).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Disconnect GitHub?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(mocks.githubDisconnect).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Connect GitHub" })).toBeEnabled();
  });
});
