import { useEffect, useState } from "react";
import type { AgentSkillDto } from "../../lib/agent-runtime-contract";
import {
  agentHudHide,
  agentHudShow,
  listAgentSkills,
  setAgentSkillEnabled,
  type FolderDto,
} from "../../lib/tauri";
import {
  AGENT_HUD_VISIBILITY_CHANGED_EVENT,
  getAgentHudEnabled,
  setAgentHudEnabled,
  type AgentHudVisibilityChangedDetail,
} from "../../lib/agent-hud-settings";
import {
  AGENT_SOUNDS_CHANGED_EVENT,
  getAgentSoundsEnabled,
  setAgentSoundsEnabled,
  type AgentSoundsChangedDetail,
} from "../../lib/agent-sound-settings";
import { Switch } from "../ui/Switch";
import { SettingsPageHeader } from "./AppSettings";

/** Settings owned by June's local agent harness. Messaging compatibility,
 * raw runtime diagnostics, and the legacy filesystem browser are
 * intentionally absent. */
export function AgentSettingsSection({
  folders: _folders = [],
  onFoldersImported: _onFoldersImported,
}: {
  selectedPlatformId?: string;
  onSelectPlatform?: (platformId: string) => void;
  onBackFromPlatform?: () => void;
  folders?: FolderDto[];
  onFoldersImported?: (folders: FolderDto[]) => void;
} = {}) {
  const [hudEnabled, setHudEnabledState] = useState(getAgentHudEnabled);
  const [soundsEnabled, setSoundsEnabledState] = useState(getAgentSoundsEnabled);
  const [skills, setSkills] = useState<AgentSkillDto[]>();
  const [savingSkillId, setSavingSkillId] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void listAgentSkills()
      .then(setSkills)
      .catch((cause) => setError(messageFromError(cause)));
  }, []);

  useEffect(() => {
    const handleHud = (event: Event) => {
      const detail = (event as CustomEvent<AgentHudVisibilityChangedDetail>).detail;
      if (detail) setHudEnabledState(detail.enabled);
    };
    const handleSounds = (event: Event) => {
      const detail = (event as CustomEvent<AgentSoundsChangedDetail>).detail;
      if (detail) setSoundsEnabledState(detail.enabled);
    };
    window.addEventListener(AGENT_HUD_VISIBILITY_CHANGED_EVENT, handleHud);
    window.addEventListener(AGENT_SOUNDS_CHANGED_EVENT, handleSounds);
    return () => {
      window.removeEventListener(AGENT_HUD_VISIBILITY_CHANGED_EVENT, handleHud);
      window.removeEventListener(AGENT_SOUNDS_CHANGED_EVENT, handleSounds);
    };
  }, []);

  async function changeHud(enabled: boolean) {
    setHudEnabledState(enabled);
    setAgentHudEnabled(enabled);
    try {
      if (enabled) await agentHudShow();
      else await agentHudHide();
    } catch (cause) {
      setHudEnabledState(!enabled);
      setAgentHudEnabled(!enabled);
      setError(messageFromError(cause));
    }
  }

  async function changeSkill(skill: AgentSkillDto, enabled: boolean) {
    setSavingSkillId(skill.id);
    try {
      const updated = await setAgentSkillEnabled(skill.id, enabled);
      setSkills((current) => current?.map((item) => (item.id === updated.id ? updated : item)));
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setSavingSkillId(undefined);
    }
  }

  return (
    <>
      <section className="settings-group" aria-labelledby="agent-heading">
        <SettingsPageHeader
          id="agent-heading"
          title="Agent"
          blurb="Configure June's local agent experience."
        />
        <div className="settings-card">
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Sessions HUD</h3>
                <p className="settings-row-description">
                  Show live session status at the top right of your screen.
                </p>
              </div>
              <div className="settings-row-control">
                <Switch
                  checked={hudEnabled}
                  onCheckedChange={(enabled) => void changeHud(enabled)}
                  aria-label="Show sessions HUD"
                />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Agent sounds</h3>
                <p className="settings-row-description">
                  Play a sound when a session finishes or needs you.
                </p>
              </div>
              <div className="settings-row-control">
                <Switch
                  checked={soundsEnabled}
                  onCheckedChange={(enabled) => {
                    setSoundsEnabledState(enabled);
                    setAgentSoundsEnabled(enabled);
                  }}
                  aria-label="Play agent sounds"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="agent-skills-heading">
        <h2 id="agent-skills-heading" className="settings-group-heading">
          Skills
        </h2>
        <p className="settings-group-description">
          Choose which skills June can load during a session.
        </p>
        <div className="settings-card">
          <div className="settings-rows">
            {skills?.map((skill) => (
              <div className="settings-row" key={skill.id}>
                <div className="settings-row-info">
                  <h3 className="settings-row-title">{skill.name}</h3>
                  <p className="settings-row-description">{skill.description}</p>
                </div>
                <div className="settings-row-control">
                  <Switch
                    checked={skill.enabled}
                    disabled={savingSkillId === skill.id}
                    onCheckedChange={(enabled) => void changeSkill(skill, enabled)}
                    aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
                  />
                </div>
              </div>
            ))}
            {skills?.length === 0 ? <p className="settings-empty">No skills found.</p> : null}
          </div>
        </div>
        {error ? (
          <p className="settings-row-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </>
  );
}

function messageFromError(error: unknown) {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Unable to update agent settings.";
}
