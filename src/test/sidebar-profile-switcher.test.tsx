import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SidebarProfileSwitcher } from "../components/sidebar/Sidebar";
import type { ProfileManagerState } from "../lib/hermes-admin";

function stubManager(overrides: Partial<ProfileManagerState> = {}): ProfileManagerState {
  return {
    status: "ready",
    profiles: [
      { name: "default", raw: {} },
      { name: "research", raw: {} },
      { name: "writing", raw: {} },
    ],
    activeName: "research",
    activeConfirmed: true,
    pendingAction: null,
    pendingRemoval: null,
    error: null,
    activate: vi.fn().mockResolvedValue(true),
    beginRemove: vi.fn().mockResolvedValue(true),
    confirmRemoval: vi.fn().mockResolvedValue(true),
    cancelRemoval: vi.fn(),
    refresh: vi.fn(),
    dismissError: vi.fn(),
    ...overrides,
  };
}

function renderSwitcher(state: ProfileManagerState) {
  const onSwitched = vi.fn();
  const onManageProfiles = vi.fn();
  render(
    <SidebarProfileSwitcher
      state={state}
      onSwitched={onSwitched}
      onManageProfiles={onManageProfiles}
    />,
  );
  return { onSwitched, onManageProfiles };
}

describe("SidebarProfileSwitcher", () => {
  it("stays hidden until a second profile exists", () => {
    renderSwitcher(stubManager({ profiles: [{ name: "default", raw: {} }] }));
    expect(screen.queryByRole("group", { name: "Profiles" })).not.toBeInTheDocument();
  });

  it("stays hidden while the manager is not ready", () => {
    renderSwitcher(stubManager({ status: "loading", profiles: [] }));
    expect(screen.queryByRole("group", { name: "Profiles" })).not.toBeInTheDocument();
  });

  it("lists every profile and checks only the active one", () => {
    renderSwitcher(stubManager());
    const rows = screen.getAllByRole("menuitemradio");
    expect(rows.map((row) => row.textContent)).toEqual(["default", "research", "writing"]);
    expect(screen.getByRole("menuitemradio", { name: "research" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "default" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("activates the picked profile and closes the menu on success", async () => {
    const state = stubManager();
    const { onSwitched } = renderSwitcher(state);
    await userEvent.click(screen.getByRole("menuitemradio", { name: "writing" }));
    expect(state.activate).toHaveBeenCalledWith("writing");
    await waitFor(() => expect(onSwitched).toHaveBeenCalledTimes(1));
  });

  it("keeps the menu open when the switch fails", async () => {
    const state = stubManager({ activate: vi.fn().mockResolvedValue(false) });
    const { onSwitched } = renderSwitcher(state);
    await userEvent.click(screen.getByRole("menuitemradio", { name: "writing" }));
    expect(state.activate).toHaveBeenCalledWith("writing");
    await waitFor(() => expect(state.activate).toHaveBeenCalled());
    expect(onSwitched).not.toHaveBeenCalled();
  });

  it("treats picking the active profile as a plain close", async () => {
    const state = stubManager();
    const { onSwitched } = renderSwitcher(state);
    await userEvent.click(screen.getByRole("menuitemradio", { name: "research" }));
    expect(state.activate).not.toHaveBeenCalled();
    expect(onSwitched).toHaveBeenCalledTimes(1);
  });

  it("parks every row while a switch is in flight", () => {
    renderSwitcher(stubManager({ pendingAction: { kind: "activate", name: "writing" } }));
    for (const row of screen.getAllByRole("menuitemradio")) {
      expect(row).toBeDisabled();
    }
  });

  it("blocks switching while the active profile is unconfirmed", () => {
    renderSwitcher(stubManager({ activeConfirmed: false }));
    expect(screen.getByRole("menuitemradio", { name: "writing" })).toBeDisabled();
  });

  it("surfaces a failed-switch error inline", () => {
    renderSwitcher(stubManager({ error: "Hermes rejected the switch." }));
    expect(screen.getByRole("alert")).toHaveTextContent("Hermes rejected the switch.");
  });

  it("opens profile management from the trailing row", async () => {
    const { onManageProfiles } = renderSwitcher(stubManager());
    await userEvent.click(screen.getByRole("menuitem", { name: "Manage profiles" }));
    expect(onManageProfiles).toHaveBeenCalledTimes(1);
  });
});
