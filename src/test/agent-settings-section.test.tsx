import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSettingsSection } from "../components/settings/AgentSettingsSection";
import { AGENT_HUD_ENABLED_KEY, AGENT_HUD_PLACEMENT_KEY } from "../lib/agent-hud-settings";
import { onboardingArea, onboardingMood } from "../lib/onboarding";

const mocks = vi.hoisted(() => ({
  agentHudHide: vi.fn(),
  agentHudShow: vi.fn(),
  emit: vi.fn().mockResolvedValue(undefined),
  clovyPersona: vi.fn(),
  listAgentSkills: vi.fn(),
  setClovyPersona: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
}));

vi.mock("../lib/tauri", () => ({
  agentHudHide: mocks.agentHudHide,
  agentHudShow: mocks.agentHudShow,
  clovyPersona: mocks.clovyPersona,
  listAgentSkills: mocks.listAgentSkills,
  readAgentSkill: vi.fn(),
  setAgentSkillEnabled: vi.fn(),
  setClovyPersona: mocks.setClovyPersona,
  updateAgentSkill: vi.fn(),
}));

describe("AgentSettingsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.listAgentSkills.mockResolvedValue([]);
    mocks.clovyPersona.mockResolvedValue({
      schemaVersion: 1,
      area: "personal",
      voice: 80,
      detail: 55,
      initiative: 70,
      humor: 45,
    });
    mocks.setClovyPersona.mockImplementation(async (request) => ({
      schemaVersion: 1,
      ...request,
    }));
  });

  it("loads the current native personality into the Agent settings", async () => {
    render(<AgentSettingsSection />);

    expect(await screen.findByRole("heading", { name: "Personality" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Calm/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Calm/ }).closest("label")).toHaveClass(
      "settings-card",
    );
    expect(screen.getByText("Take your time. What should we think through first?")).toHaveClass(
      "shimmer",
    );
    expect(document.querySelector(".settings-personality-option-check")).toBeNull();
    expect(screen.queryByText("Focus area")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("automatically saves a new personality while preserving the onboarding area", async () => {
    const user = userEvent.setup();
    render(<AgentSettingsSection />);
    await screen.findByRole("radio", { name: /Calm/ });

    await user.click(screen.getByRole("radio", { name: /Quick-witted/ }));

    expect(mocks.setClovyPersona).toHaveBeenCalledWith({
      area: "personal",
      voice: 85,
      detail: 70,
      initiative: 80,
      humor: 95,
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(onboardingArea()).toBe("personal");
    expect(onboardingMood()).toBe("quick-witted");
  });

  it("restores the persisted personality when an automatic save fails", async () => {
    const user = userEvent.setup();
    mocks.setClovyPersona.mockRejectedValueOnce(new Error("Could not write persona settings"));
    render(<AgentSettingsSection />);
    await screen.findByRole("radio", { name: /Calm/ });

    await user.click(screen.getByRole("radio", { name: /Strategic/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not write persona settings");
    expect(screen.getByRole("radio", { name: /Calm/ })).toBeChecked();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(onboardingArea()).toBeNull();
  });

  it("keeps a queued personality visible and rolls it back to the latest successful save", async () => {
    const user = userEvent.setup();
    const firstSave = deferred<{
      schemaVersion: number;
      area: "personal";
      voice: number;
      detail: number;
      initiative: number;
      humor: number;
    }>();
    const secondSave = deferred<never>();
    mocks.setClovyPersona
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    render(<AgentSettingsSection />);
    await screen.findByRole("radio", { name: /Calm/ });

    await user.click(screen.getByRole("radio", { name: /Quick-witted/ }));
    await user.click(screen.getByRole("radio", { name: /Strategic/ }));

    await act(async () => {
      firstSave.resolve({
        schemaVersion: 1,
        area: "personal",
        voice: 85,
        detail: 70,
        initiative: 80,
        humor: 95,
      });
    });
    await waitFor(() => expect(mocks.setClovyPersona).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("radio", { name: /Strategic/ })).toBeChecked();

    await act(async () => {
      secondSave.reject(new Error("Could not save queued persona"));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save queued persona");
    expect(screen.getByRole("radio", { name: /Quick-witted/ })).toBeChecked();
    expect(onboardingMood()).toBe("quick-witted");
  });

  it("lets the HUD window react to visibility changes without directly showing it", async () => {
    const user = userEvent.setup();
    render(<AgentSettingsSection />);
    await screen.findByText("No skills found.");

    const hudSwitch = screen.getByRole("switch", {
      name: "Show sessions HUD",
    });

    await user.click(hudSwitch);
    expect(localStorage.getItem(AGENT_HUD_ENABLED_KEY)).toBe("false");

    await user.click(hudSwitch);
    expect(localStorage.getItem(AGENT_HUD_ENABLED_KEY)).toBe("true");
    expect(mocks.agentHudShow).not.toHaveBeenCalled();
    expect(mocks.agentHudHide).not.toHaveBeenCalled();
  });

  it("stores the selected HUD corner", async () => {
    const user = userEvent.setup();
    render(<AgentSettingsSection />);
    await screen.findByText("No skills found.");

    await user.click(
      screen.getByRole("button", {
        name: "Sessions HUD position",
      }),
    );
    await user.click(screen.getByRole("option", { name: "Bottom left" }));

    expect(localStorage.getItem(AGENT_HUD_PLACEMENT_KEY)).toBe("bottom-left");
    expect(
      screen.getByRole("button", {
        name: "Sessions HUD position",
      }),
    ).toHaveTextContent("Bottom left");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
