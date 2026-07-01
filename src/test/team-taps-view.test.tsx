import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TeamTapsView } from "../components/settings/TeamTapsSection";
import {
  validateTapPath,
  validateTapRepo,
  type SkillTapsState,
} from "../lib/hermes-admin";

/** Builds a stubbed SkillTapsState so the view renders with no Tauri/network. */
function stubState(overrides: Partial<SkillTapsState> = {}): SkillTapsState {
  return {
    status: "ready",
    taps: [],
    mode: "sandboxed",
    profile: "default",
    pending: new Set<string>(),
    retryable: false,
    needsGithubToken: false,
    search: { status: "idle", query: "", results: [], retryable: false },
    installs: new Map(),
    lifecycle: {
      state: "clean",
      label: "Up to date",
      detail: "No pending changes.",
      canRestart: false,
    },
    notifications: [],
    refresh: vi.fn(),
    addTap: vi.fn(async () => {}),
    removeTap: vi.fn(async () => {}),
    searchTap: vi.fn(),
    refreshSearch: vi.fn(),
    clearSearch: vi.fn(),
    installSkill: vi.fn(),
    clearInstall: vi.fn(),
    validateRepo: validateTapRepo,
    validatePath: validateTapPath,
    dismissNotification: vi.fn(),
    ...overrides,
  };
}

describe("TeamTapsView", () => {
  it("shows the org-friendly tap explainer copy", () => {
    render(<TeamTapsView state={stubState()} />);
    expect(
      screen.getByText(/A tap is a GitHub repository of reusable SKILL.md/i),
    ).toBeTruthy();
  });

  it("lists configured taps with a community trust badge by default", () => {
    const state = stubState({
      taps: [
        { repo: "acme/runbooks", trusted: false },
        { repo: "acme/trusted", trusted: true },
      ],
    });
    render(<TeamTapsView state={state} />);
    expect(screen.getByText("acme/runbooks")).toBeTruthy();
    expect(screen.getAllByText("Community").length).toBeGreaterThan(0);
    expect(screen.getByText("Trusted")).toBeTruthy();
  });

  it("disables Add tap and shows an error for an invalid owner/repo", () => {
    render(<TeamTapsView state={stubState()} />);
    const input = screen.getByLabelText("Tap repository as owner/repo");
    fireEvent.change(input, { target: { value: "not-a-repo" } });
    const addButton = screen.getByRole("button", { name: "Add tap" });
    expect((addButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/owner\/repo/i);
  });

  it("adds a valid tap with its path override", async () => {
    const addTap = vi.fn(async () => {});
    render(<TeamTapsView state={stubState({ addTap })} />);
    fireEvent.change(screen.getByLabelText("Tap repository as owner/repo"), {
      target: { value: "acme/runbooks" },
    });
    fireEvent.change(
      screen.getByLabelText("Path override inside the repository"),
      { target: { value: "skills/ops" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add tap" }));
    expect(addTap).toHaveBeenCalledWith("acme/runbooks", "skills/ops");
  });

  it("removes a tap through the remove action", () => {
    const removeTap = vi.fn(async () => {});
    const state = stubState({
      taps: [{ repo: "acme/runbooks", trusted: false }],
      removeTap,
    });
    render(<TeamTapsView state={state} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove acme/runbooks" }),
    );
    expect(removeTap).toHaveBeenCalledWith("acme/runbooks");
  });

  it("shows the GITHUB_TOKEN setup callout on a rate-limit / auth error", () => {
    const onConfigureGithubToken = vi.fn();
    const state = stubState({
      needsGithubToken: true,
      error: "API rate limit exceeded",
    });
    render(
      <TeamTapsView
        state={state}
        onConfigureGithubToken={onConfigureGithubToken}
      />,
    );
    expect(screen.getByText(/GitHub access needed/i)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Configure GITHUB_TOKEN/i }),
    );
    expect(onConfigureGithubToken).toHaveBeenCalled();
  });

  it("searches a selected tap and installs a skill", () => {
    const installSkill = vi.fn();
    const state = stubState({
      taps: [{ repo: "acme/runbooks", trusted: false }],
      search: {
        repo: "acme/runbooks",
        status: "ready",
        query: "",
        results: [
          {
            identifier: "acme/runbooks/deploy",
            name: "Deploy",
            trust: "community",
            raw: {},
          },
        ],
        retryable: false,
      },
      installSkill,
    });
    render(<TeamTapsView state={state} />);
    expect(screen.getByText("Deploy")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Install/i }));
    expect(installSkill).toHaveBeenCalled();
  });
});
