import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSettingsSection } from "../components/settings/AgentSettingsSection";
import { AGENT_HUD_ENABLED_KEY, AGENT_HUD_PLACEMENT_KEY } from "../lib/agent-hud-settings";

const mocks = vi.hoisted(() => ({
  agentHudHide: vi.fn(),
  agentHudShow: vi.fn(),
  emit: vi.fn().mockResolvedValue(undefined),
  listAgentSkills: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
}));

vi.mock("../lib/tauri", () => ({
  agentHudHide: mocks.agentHudHide,
  agentHudShow: mocks.agentHudShow,
  listAgentSkills: mocks.listAgentSkills,
  readAgentSkill: vi.fn(),
  setAgentSkillEnabled: vi.fn(),
  updateAgentSkill: vi.fn(),
}));

describe("AgentSettingsSection HUD settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.listAgentSkills.mockResolvedValue([]);
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
