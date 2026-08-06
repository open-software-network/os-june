import { useEffect, useState } from "react";
import type { AgentSkillDto } from "../../lib/agent-runtime-contract";
import {
  listAgentSkills,
  readAgentSkill,
  setAgentSkillEnabled,
  updateAgentSkill,
  type FolderDto,
} from "../../lib/tauri";
import {
  AGENT_HUD_VISIBILITY_CHANGED_EVENT,
  getAgentHudEnabled,
  getAgentHudPlacement,
  setAgentHudEnabled,
  setAgentHudPlacement,
  type AgentHudPlacement,
  type AgentHudVisibilityChangedDetail,
} from "../../lib/agent-hud-settings";
import {
  AGENT_SOUNDS_CHANGED_EVENT,
  getAgentSoundsEnabled,
  setAgentSoundsEnabled,
  type AgentSoundsChangedDetail,
} from "../../lib/agent-sound-settings";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { SettingsPageHeader } from "./AppSettings";
import { ClovyPersonalitySettingsSection } from "./ClovyPersonalitySettingsSection";

/** Settings owned by Clovy's local agent harness. Messaging compatibility,
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
  const [hudPlacement, setHudPlacementState] = useState(getAgentHudPlacement);
  const [soundsEnabled, setSoundsEnabledState] = useState(getAgentSoundsEnabled);
  const [skills, setSkills] = useState<AgentSkillDto[]>();
  const [savingSkillId, setSavingSkillId] = useState<string>();
  const [editingSkill, setEditingSkill] = useState<AgentSkillDto>();
  const [skillDraft, setSkillDraft] = useState("");
  const [skillSaving, setSkillSaving] = useState(false);
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

  function changeHud(enabled: boolean) {
    setHudEnabledState(enabled);
    setAgentHudEnabled(enabled);
  }

  function changeHudPlacement(placement: AgentHudPlacement) {
    setHudPlacementState(placement);
    setAgentHudPlacement(placement);
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

  async function editSkill(skill: AgentSkillDto) {
    try {
      const document = await readAgentSkill(skill.id);
      setSkillDraft(document.content);
      setEditingSkill(skill);
    } catch (cause) {
      setError(messageFromError(cause));
    }
  }

  async function saveSkill() {
    if (!editingSkill) return;
    setSkillSaving(true);
    try {
      const updated = await updateAgentSkill(editingSkill.id, skillDraft);
      setSkills((current) => current?.map((item) => (item.id === updated.id ? updated : item)));
      setEditingSkill(undefined);
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setSkillSaving(false);
    }
  }

  return (
    <>
      <section className="settings-group" aria-labelledby="agent-heading">
        <SettingsPageHeader
          id="agent-heading"
          title="Agent"
          blurb="Configure Clovy's personality and local agent experience."
        />
        <ClovyPersonalitySettingsSection />
      </section>

      <section className="settings-group" aria-labelledby="agent-experience-heading">
        <h2 id="agent-experience-heading" className="settings-group-heading">
          Experience
        </h2>
        <p className="settings-group-description">
          Control how Clovy keeps you informed while she works.
        </p>
        <div className="settings-card">
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Sessions HUD</h3>
                <p className="settings-row-description">
                  Show a small pill with live session status while you are in other apps.
                </p>
              </div>
              <div className="settings-row-control">
                <Switch
                  checked={hudEnabled}
                  onCheckedChange={changeHud}
                  aria-label="Show sessions HUD"
                />
              </div>
            </div>
            {hudEnabled ? (
              <div className="settings-row">
                <div className="settings-row-info">
                  <h3 className="settings-row-title">HUD position</h3>
                  <p className="settings-row-description">
                    The screen corner where the pill parks.
                  </p>
                </div>
                <div className="settings-row-control">
                  <Select
                    value={hudPlacement}
                    options={[
                      { value: "top-left", label: "Top left" },
                      { value: "top-right", label: "Top right" },
                      { value: "bottom-left", label: "Bottom left" },
                      { value: "bottom-right", label: "Bottom right" },
                    ]}
                    placeholder="Top right"
                    ariaLabel="Sessions HUD position"
                    onChange={(value) => changeHudPlacement(value as AgentHudPlacement)}
                  />
                </div>
              </div>
            ) : null}
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
          Choose which skills Clovy can load during a session.
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
                  {skill.editable ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void editSkill(skill)}
                    >
                      Edit
                    </button>
                  ) : null}
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
      <Dialog
        open={Boolean(editingSkill)}
        onClose={() => setEditingSkill(undefined)}
        title={editingSkill ? `Edit ${editingSkill.name}` : "Edit skill"}
        description="Update the managed instructions Clovy loads for this skill."
        footer={
          <>
            <button
              type="button"
              className="primary-action"
              onClick={() => setEditingSkill(undefined)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={skillSaving}
              onClick={() => void saveSkill()}
            >
              {skillSaving ? "Saving..." : "Save skill"}
            </button>
          </>
        }
      >
        <textarea
          className="settings-skill-editor"
          aria-label="Skill instructions"
          value={skillDraft}
          onChange={(event) => setSkillDraft(event.currentTarget.value)}
          rows={18}
          spellCheck={false}
        />
      </Dialog>
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
