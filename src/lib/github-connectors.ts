import type { GitHubConnection, GitHubConnectionStatus } from "./tauri";

export function githubRepositoryCount(connection: GitHubConnection): number {
  return connection.installations.reduce(
    (total, installation) => total + installation.repositories.length,
    0,
  );
}

export function githubStatusLabel(status: GitHubConnectionStatus): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "setup_incomplete":
      return "Setup incomplete";
    case "reconnect_required":
      return "Reconnect required";
  }
}

export function githubConnectionSubtitle(connection: GitHubConnection): string {
  const count = githubRepositoryCount(connection);
  return `${connection.login} · ${count} ${count === 1 ? "repository" : "repositories"}`;
}
