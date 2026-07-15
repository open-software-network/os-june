import { useCallback, useEffect, useRef, useState } from "react";
import { githubConnectionSubtitle, githubStatusLabel } from "../../lib/github-connectors";
import type { GitHubConnection, GitHubDevicePrompt } from "../../lib/tauri";
import {
  githubConnectCancel,
  githubConnectStart,
  githubConnectWait,
  githubDisconnect,
  githubInstallationOpen,
  githubInstallationsRefresh,
} from "../../lib/tauri";
import { ConnectorProviderIcon } from "../connectors/ConnectorProviderIcon";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";
import { HoverTip } from "../ui/HoverTip";
import { InlineNotice } from "../ui/InlineNotice";

export type GitHubConnectorRowProps = {
  connection: GitHubConnection | null;
  loading: boolean;
  onConnectionChanged: (connection: GitHubConnection | null) => void;
};

function githubErrorCode(cause: unknown): string | null {
  if (!cause || typeof cause !== "object" || !("code" in cause)) return null;
  return typeof cause.code === "string" ? cause.code : null;
}

export function githubErrorMessage(cause: unknown): string {
  switch (githubErrorCode(cause)) {
    case "github_not_configured":
      return "GitHub is not configured for this build.";
    case "github_connect_pending":
      return "GitHub authorization is still pending.";
    case "github_connect_slow_down":
      return "GitHub asked June to wait before checking again.";
    case "github_connect_denied":
      return "GitHub authorization was denied. Try again.";
    case "github_connect_expired":
      return "The GitHub authorization code expired. Try again.";
    case "github_connect_canceled":
      return "GitHub authorization was canceled. Try again.";
    case "github_rate_limited":
      return "GitHub is temporarily rate limited. Try again later.";
    case "github_token_exchange_failed":
      return "GitHub returned an invalid authorization response. Try again.";
    case "github_refresh_failed":
      return "GitHub repositories could not be refreshed. Try again.";
    case "github_reconnect_required":
      return "GitHub authorization expired. Reconnect to continue.";
    case "github_installation_required":
      return "Install the GitHub App and choose repositories to continue.";
    case "github_installation_suspended":
      return "This GitHub App installation is suspended.";
    case "github_repository_access_removed":
      return "GitHub repository access changed. Refresh to continue.";
    default:
      return "GitHub could not complete the connection. Try again.";
  }
}

function safeGitHubAvatarUrl(avatarUrl?: string): string | null {
  if (!avatarUrl) return null;
  try {
    const parsed = new URL(avatarUrl);
    return parsed.protocol === "https:" && parsed.hostname === "avatars.githubusercontent.com"
      ? avatarUrl
      : null;
  } catch {
    return null;
  }
}

export function GitHubConnectorRow({
  connection,
  loading,
  onConnectionChanged,
}: GitHubConnectorRowProps) {
  const [prompt, setPrompt] = useState<GitHubDevicePrompt | null>(null);
  const [deviceDialogOpen, setDeviceDialogOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const flowGeneration = useRef(0);
  const flowPending = useRef(false);
  const lifecycleGeneration = useRef(0);
  const onConnectionChangedRef = useRef(onConnectionChanged);
  const refreshingRef = useRef(false);
  const installationReturnRefreshArmed = useRef(false);
  const installationReturnRefreshQueuedGeneration = useRef<number | null>(null);

  useEffect(() => {
    onConnectionChangedRef.current = onConnectionChanged;
  }, [onConnectionChanged]);

  useEffect(
    () => () => {
      flowGeneration.current += 1;
      installationReturnRefreshArmed.current = false;
      installationReturnRefreshQueuedGeneration.current = null;
      lifecycleGeneration.current += 1;
      if (!flowPending.current) return;
      flowPending.current = false;
      void githubConnectCancel().catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (connection?.status !== "connected") setDetailsOpen(false);
  }, [connection?.status]);

  async function beginConnect() {
    if (connecting) return;
    const generation = ++flowGeneration.current;
    flowPending.current = true;
    setConnecting(true);
    setError(null);
    setCopied(false);
    try {
      const nextPrompt = await githubConnectStart();
      if (generation !== flowGeneration.current) return;
      setPrompt(nextPrompt);
      setDeviceDialogOpen(true);
      const nextConnection = await githubConnectWait();
      if (generation !== flowGeneration.current) return;
      flowPending.current = false;
      setDeviceDialogOpen(false);
      setPrompt(null);
      setConnecting(false);
      onConnectionChanged(nextConnection);
    } catch (cause) {
      if (generation !== flowGeneration.current) return;
      flowPending.current = false;
      setDeviceDialogOpen(false);
      setPrompt(null);
      setConnecting(false);
      setError(githubErrorMessage(cause));
    }
  }

  async function cancelConnect() {
    const generation = ++flowGeneration.current;
    const wasPending = flowPending.current;
    flowPending.current = false;
    setDeviceDialogOpen(false);
    setPrompt(null);
    if (!wasPending) {
      setConnecting(false);
      return;
    }
    try {
      await githubConnectCancel();
    } catch {
      if (generation === flowGeneration.current) {
        setError("GitHub authorization could not be canceled. Try again.");
      }
    } finally {
      if (generation === flowGeneration.current) setConnecting(false);
    }
  }

  async function copyCode() {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt.userCode);
      setCopied(true);
    } catch {
      setError("Could not copy the code. Copy it manually.");
    }
  }

  const refreshInstallations = useCallback(async function refreshInstallations() {
    if (refreshingRef.current) return;
    const generation = lifecycleGeneration.current;
    refreshingRef.current = true;
    setRefreshing(true);
    setError(null);
    try {
      const nextConnection = await githubInstallationsRefresh();
      if (generation !== lifecycleGeneration.current) return;
      onConnectionChangedRef.current(nextConnection);
    } catch (cause) {
      if (generation !== lifecycleGeneration.current) return;
      setError(githubErrorMessage(cause));
    } finally {
      if (generation === lifecycleGeneration.current) {
        refreshingRef.current = false;
        if (installationReturnRefreshQueuedGeneration.current === generation) {
          installationReturnRefreshQueuedGeneration.current = null;
          void refreshInstallations();
        } else {
          setRefreshing(false);
        }
      }
    }
  }, []);

  useEffect(() => {
    function refreshAfterInstallationReturn() {
      if (!installationReturnRefreshArmed.current) return;
      installationReturnRefreshArmed.current = false;
      if (refreshingRef.current) {
        installationReturnRefreshQueuedGeneration.current = lifecycleGeneration.current;
        return;
      }
      void refreshInstallations();
    }

    window.addEventListener("focus", refreshAfterInstallationReturn);
    return () => {
      installationReturnRefreshArmed.current = false;
      installationReturnRefreshQueuedGeneration.current = null;
      window.removeEventListener("focus", refreshAfterInstallationReturn);
    };
  }, [refreshInstallations]);

  async function openInstallation(installationId?: string) {
    setError(null);
    try {
      if (installationId) await githubInstallationOpen(installationId);
      else await githubInstallationOpen();
      installationReturnRefreshArmed.current = true;
    } catch (cause) {
      installationReturnRefreshArmed.current = false;
      setError(githubErrorMessage(cause));
    }
  }

  async function disconnect() {
    installationReturnRefreshArmed.current = false;
    installationReturnRefreshQueuedGeneration.current = null;
    refreshingRef.current = false;
    const generation = ++lifecycleGeneration.current;
    setRefreshing(false);
    setDetailsOpen(false);
    setError(null);
    try {
      await githubDisconnect();
      if (generation !== lifecycleGeneration.current) return;
      onConnectionChanged(null);
    } catch (cause) {
      if (generation === lifecycleGeneration.current) setError(githubErrorMessage(cause));
      throw cause;
    }
  }

  const reconnectRequired = connection?.status === "reconnect_required";
  const connectedIdentity = connection !== null && !reconnectRequired;
  const status = connection ? githubStatusLabel(connection.status) : null;
  const subtitle = connectedIdentity
    ? githubConnectionSubtitle(connection)
    : reconnectRequired
      ? "Authorization expired. Reconnect to restore access."
      : "Repository access for issues, pull requests, and code.";
  const avatarUrl = connectedIdentity ? safeGitHubAvatarUrl(connection.avatarUrl) : null;

  return (
    <li
      className="connector-row github-connector-row"
      aria-busy={loading || connecting || refreshing}
    >
      <span className="connector-logo">
        {avatarUrl && connection ? (
          <img
            className="github-avatar"
            src={avatarUrl}
            alt={`${connection.login} GitHub avatar`}
          />
        ) : (
          <ConnectorProviderIcon provider="github" />
        )}
      </span>
      <div className="connector-main">
        <span className="connector-name">GitHub</span>
        <HoverTip
          tip={subtitle}
          className="connector-subtitle github-connector-subtitle"
          tabIndex={0}
        >
          {subtitle}
        </HoverTip>
      </div>
      <div className="connector-actions">
        {connection && status ? (
          <span
            className="status-pill"
            data-tone={connection.status === "connected" ? "ok" : "warning"}
          >
            {status}
          </span>
        ) : null}
        {!connection ? (
          <button
            type="button"
            className="primary-action"
            aria-label="Connect GitHub"
            disabled={loading || connecting}
            aria-busy={connecting || undefined}
            onClick={() => void beginConnect()}
          >
            Connect
          </button>
        ) : reconnectRequired ? (
          <button
            type="button"
            className="primary-action"
            aria-label="Reconnect GitHub"
            disabled={loading || connecting}
            aria-busy={connecting || undefined}
            onClick={() => void beginConnect()}
          >
            Reconnect
          </button>
        ) : connection.status === "setup_incomplete" ? (
          <>
            <button
              type="button"
              className="primary-action"
              disabled={loading}
              onClick={() => void openInstallation()}
            >
              Install GitHub App
            </button>
            {connection.installations.map((installation) => (
              <button
                key={installation.installationId}
                type="button"
                className="primary-action"
                aria-label={`Manage repositories for ${installation.ownerLogin}`}
                disabled={loading}
                onClick={() => void openInstallation(installation.installationId)}
              >
                Manage repositories
              </button>
            ))}
          </>
        ) : (
          <>
            <button
              type="button"
              className="primary-action"
              aria-label="Refresh GitHub repositories"
              disabled={loading || refreshing}
              aria-busy={refreshing || undefined}
              onClick={() => void refreshInstallations()}
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
            <button
              type="button"
              className="primary-action"
              aria-label="View GitHub repositories"
              disabled={loading}
              onClick={() => setDetailsOpen(true)}
            >
              Details
            </button>
          </>
        )}
        {connection ? (
          <button
            type="button"
            className="primary-action"
            aria-label="Disconnect GitHub"
            disabled={loading}
            onClick={() => setDisconnectOpen(true)}
          >
            Disconnect
          </button>
        ) : null}
      </div>

      {error ? (
        <InlineNotice
          className="github-connector-notice"
          tone={error === "GitHub is not configured for this build." ? "info" : "warning"}
          role="alert"
          body={error}
          aria-label="GitHub connection notice"
        />
      ) : null}

      <Dialog
        open={deviceDialogOpen && prompt !== null}
        onClose={() => void cancelConnect()}
        title="Connect GitHub"
        description="Enter this code on GitHub to authorize June."
        footer={
          <>
            <button type="button" className="primary-action" onClick={() => void cancelConnect()}>
              Cancel
            </button>
            {prompt ? (
              <a
                className="primary-action primary-solid"
                href={prompt.verificationUri}
                target="_blank"
                rel="noreferrer"
              >
                Open GitHub
              </a>
            ) : null}
          </>
        }
      >
        {prompt ? (
          <div className="github-device-prompt">
            <code className="github-device-code">{prompt.userCode}</code>
            <div className="github-device-actions">
              <button type="button" className="primary-action" onClick={() => void copyCode()}>
                {copied ? "Copied" : "Copy code"}
              </button>
            </div>
            <p className="github-device-pending" role="status">
              Waiting for authorization...
            </p>
          </div>
        ) : (
          <div />
        )}
      </Dialog>

      <Dialog
        open={detailsOpen && connection?.status === "connected"}
        onClose={() => setDetailsOpen(false)}
        title="GitHub repositories"
        description={
          connection ? `Repositories June can access for ${connection.login}.` : undefined
        }
        footer={
          <button type="button" className="primary-action" onClick={() => setDetailsOpen(false)}>
            Close
          </button>
        }
      >
        {connection ? (
          <ul className="github-installation-list">
            {connection.installations.map((installation) => (
              <li key={installation.installationId} className="github-installation">
                <div className="github-installation-header">
                  <h3 className="github-installation-owner">{installation.ownerLogin}</h3>
                  <button
                    type="button"
                    className="primary-action"
                    aria-label={`Manage repositories for ${installation.ownerLogin}`}
                    onClick={() => void openInstallation(installation.installationId)}
                  >
                    Manage repositories
                  </button>
                </div>
                {installation.suspendedAt ? (
                  <p className="github-installation-status">Installation suspended</p>
                ) : installation.repositories.length === 0 ? (
                  <p className="github-installation-status">No repositories selected.</p>
                ) : (
                  <ul className="github-repository-list">
                    {installation.repositories.map((repository) => (
                      <li key={repository.repositoryId} className="github-repository">
                        <span className="github-repository-name">{repository.name}</span>
                        {repository.private || repository.archived ? (
                          <span className="github-repository-metadata">
                            {repository.private ? <span>Private</span> : null}
                            {repository.archived ? <span>Archived</span> : null}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div />
        )}
      </Dialog>

      <ConfirmDialog
        open={disconnectOpen && connection !== null}
        onClose={() => setDisconnectOpen(false)}
        onConfirm={disconnect}
        title="Disconnect GitHub?"
        description="June removes the GitHub tokens from your Keychain and clears the cached connection details on this device."
        confirmLabel="Disconnect"
        confirmBusyLabel="Disconnecting..."
        destructive
      />
    </li>
  );
}
