import { describe, expect, it } from "vitest";
import {
  githubConnectionSubtitle,
  githubRepositoryCount,
  githubStatusLabel,
} from "../lib/github-connectors";
import type { GitHubConnection, GitHubRepository } from "../lib/tauri";

function githubRepositoryFixture(repositoryId: string): GitHubRepository {
  return {
    repositoryId,
    installationId: `installation-${repositoryId}`,
    ownerLogin: "octocat",
    name: `repository-${repositoryId}`,
    fullName: `octocat/repository-${repositoryId}`,
    private: false,
    archived: false,
    permissions: { pull: true },
  };
}

function githubConnectionFixture(): GitHubConnection {
  return {
    githubUserId: "583231",
    login: "octocat",
    status: "connected",
    installations: [
      {
        installationId: "installation-1",
        ownerId: "583231",
        ownerLogin: "octocat",
        ownerType: "User",
        repositorySelection: "selected",
        permissions: { contents: "read" },
        repositories: [githubRepositoryFixture("1")],
      },
      {
        installationId: "installation-2",
        ownerId: "9919",
        ownerLogin: "github",
        ownerType: "Organization",
        repositorySelection: "selected",
        permissions: { contents: "read" },
        repositories: [githubRepositoryFixture("2")],
      },
    ],
  };
}

function suspendedGitHubConnectionFixture(): GitHubConnection {
  return {
    githubUserId: "583231",
    login: "octocat",
    status: "setup_incomplete",
    installations: [
      {
        installationId: "installation-suspended",
        ownerId: "9919",
        ownerLogin: "github",
        ownerType: "Organization",
        repositorySelection: "selected",
        permissions: { contents: "read" },
        suspendedAt: "2026-07-15T00:00:00Z",
        repositories: [],
      },
    ],
  };
}

describe("GitHub connector view state", () => {
  it("counts repositories across installations", () => {
    expect(githubRepositoryCount(githubConnectionFixture())).toBe(2);
  });

  it("returns zero repositories for a suspended-only connection", () => {
    expect(githubRepositoryCount(suspendedGitHubConnectionFixture())).toBe(0);
    expect(githubConnectionSubtitle(suspendedGitHubConnectionFixture())).toBe(
      "octocat · 0 repositories",
    );
  });

  it("describes connected and incomplete states in sentence case", () => {
    expect(githubStatusLabel("connected")).toBe("Connected");
    expect(githubStatusLabel("setup_incomplete")).toBe("Setup incomplete");
    expect(githubStatusLabel("reconnect_required")).toBe("Reconnect required");
    expect(githubConnectionSubtitle(githubConnectionFixture())).toBe("octocat · 2 repositories");
  });

  it("uses repository for a single repository", () => {
    const connection = githubConnectionFixture();
    connection.installations = connection.installations.slice(0, 1);

    expect(githubConnectionSubtitle(connection)).toBe("octocat · 1 repository");
  });
});
