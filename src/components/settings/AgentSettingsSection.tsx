import { useEffect, useState } from "react";
import {
  FilesystemPanel,
  MessagingPanel,
  SkillsToolsPanel,
} from "../agent/AgentWorkspace";
import {
  hermesBridgeFilesystemSnapshot,
  hermesBridgeMessagingPlatforms,
  hermesBridgeSkills,
  hermesBridgeToolsets,
  mascotHide,
  mascotShow,
  toggleHermesBridgeSkill,
  toggleHermesBridgeToolset,
  updateHermesBridgeMessagingPlatform,
  type HermesMessagingPlatformInfo,
  type HermesSkillInfo,
  type HermesToolsetInfo,
  type HermesFilesystemSnapshot,
} from "../../lib/tauri";
import {
  getMascotEnabled,
  MASCOT_VISIBILITY_CHANGED_EVENT,
  setMascotEnabled,
  type MascotVisibilityChangedDetail,
} from "../../lib/mascot-settings";
import { Switch } from "../ui/Switch";

type AgentSettingsPanel = "skills" | "messaging" | "files";

export function AgentSettingsSection() {
  const [panel, setPanel] = useState<AgentSettingsPanel>("skills");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<HermesSkillInfo[] | null>(null);
  const [toolsets, setToolsets] = useState<HermesToolsetInfo[] | null>(null);
  const [platforms, setPlatforms] = useState<
    HermesMessagingPlatformInfo[] | null
  >(null);
  const [filesystemSnapshot, setFilesystemSnapshot] =
    useState<HermesFilesystemSnapshot | null>(null);
  const [selectedPlatformId, setSelectedPlatformId] = useState<string>();
  const [envEdits, setEnvEdits] = useState<Record<string, string>>({});
  const [mascotEnabled, setMascotEnabledState] = useState(() =>
    getMascotEnabled(),
  );

  useEffect(() => {
    if (panel === "skills" && (!skills || !toolsets)) {
      void loadCapabilities();
    }
    if (panel === "messaging" && !platforms) {
      void loadMessagingPlatforms();
    }
    if (panel === "files" && !filesystemSnapshot) {
      void loadFilesystemSnapshot();
    }
  }, [panel]);

  useEffect(() => {
    function handleVisibilityChanged(event: Event) {
      const detail = (event as CustomEvent<MascotVisibilityChangedDetail>)
        .detail;
      if (detail) setMascotEnabledState(detail.enabled);
    }

    window.addEventListener(
      MASCOT_VISIBILITY_CHANGED_EVENT,
      handleVisibilityChanged,
    );
    return () => {
      window.removeEventListener(
        MASCOT_VISIBILITY_CHANGED_EVENT,
        handleVisibilityChanged,
      );
    };
  }, []);

  async function handleMascotEnabledChange(enabled: boolean) {
    setMascotEnabledState(enabled);
    setMascotEnabled(enabled);
    try {
      if (enabled) {
        await mascotShow();
      } else {
        await mascotHide();
      }
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function loadCapabilities() {
    setLoading(true);
    try {
      const [nextSkills, nextToolsets] = await Promise.all([
        hermesBridgeSkills(),
        hermesBridgeToolsets(),
      ]);
      setSkills(nextSkills);
      setToolsets(nextToolsets);
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadMessagingPlatforms() {
    setLoading(true);
    try {
      const response = await hermesBridgeMessagingPlatforms();
      setPlatforms(response.platforms);
      setSelectedPlatformId((current) => {
        if (current && response.platforms.some((item) => item.id === current)) {
          return current;
        }
        return response.platforms[0]?.id;
      });
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadFilesystemSnapshot() {
    setLoading(true);
    try {
      const snapshot = await hermesBridgeFilesystemSnapshot();
      setFilesystemSnapshot({
        roots: snapshot.roots.filter(
          (root) => root.id === "workspace" || root.id === "memory",
        ),
      });
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setLoading(false);
    }
  }

  async function setSkillEnabled(skill: HermesSkillInfo, enabled: boolean) {
    setSaving(`skill:${skill.name}`);
    try {
      await toggleHermesBridgeSkill({ name: skill.name, enabled });
      setSkills(
        (current) =>
          current?.map((item) =>
            item.name === skill.name ? { ...item, enabled } : item,
          ) ?? current,
      );
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(null);
    }
  }

  async function setToolsetEnabled(
    toolset: HermesToolsetInfo,
    enabled: boolean,
  ) {
    setSaving(`toolset:${toolset.name}`);
    try {
      await toggleHermesBridgeToolset({ name: toolset.name, enabled });
      setToolsets(
        (current) =>
          current?.map((item) =>
            item.name === toolset.name ? { ...item, enabled } : item,
          ) ?? current,
      );
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(null);
    }
  }

  async function setMessagingPlatformEnabled(
    platform: HermesMessagingPlatformInfo,
    enabled: boolean,
  ) {
    setSaving(`messaging:${platform.id}`);
    try {
      await updateHermesBridgeMessagingPlatform({
        platformId: platform.id,
        enabled,
      });
      setPlatforms(
        (current) =>
          current?.map((item) =>
            item.id === platform.id ? { ...item, enabled } : item,
          ) ?? current,
      );
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(null);
    }
  }

  async function saveMessagingPlatformEnv(
    platform: HermesMessagingPlatformInfo,
  ) {
    const env = Object.fromEntries(
      Object.entries(envEdits)
        .map(([key, value]) => [key, value.trim()])
        .filter(([, value]) => value.length > 0),
    );
    if (!Object.keys(env).length) return;
    setSaving(`env:${platform.id}`);
    try {
      await updateHermesBridgeMessagingPlatform({
        platformId: platform.id,
        env,
      });
      setEnvEdits({});
      await loadMessagingPlatforms();
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="settings-group" aria-labelledby="agent-heading">
      <h2 id="agent-heading" className="settings-group-heading">
        Agent
      </h2>
      <p className="settings-group-description">
        Configure Hermes capabilities and external messaging channels.
      </p>
      <div className="settings-card">
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">Desktop mascot</h3>
              <p className="settings-row-description">
                Keep June visible at the bottom right with live agent session
                status.
              </p>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={mascotEnabled}
                onCheckedChange={(enabled) =>
                  void handleMascotEnabledChange(enabled)
                }
                aria-label="Show desktop mascot"
              />
            </div>
          </div>
        </div>
      </div>
      <div className="settings-card settings-agent-card">
        <div
          className="settings-section-tabs"
          role="tablist"
          aria-label="Agent settings"
        >
          <button
            type="button"
            aria-selected={panel === "skills"}
            onClick={() => {
              setPanel("skills");
              setQuery("");
            }}
          >
            Skills
          </button>
          <button
            type="button"
            aria-selected={panel === "messaging"}
            onClick={() => {
              setPanel("messaging");
              setQuery("");
            }}
          >
            Messaging
          </button>
          <button
            type="button"
            aria-selected={panel === "files"}
            onClick={() => {
              setPanel("files");
              setQuery("");
            }}
          >
            Files
          </button>
        </div>
        {error ? <p className="settings-row-error">{error}</p> : null}
        {panel === "skills" ? (
          <SkillsToolsPanel
            loading={loading}
            query={query}
            saving={saving}
            skills={skills}
            toolsets={toolsets}
            onQueryChange={setQuery}
            onRefresh={() => void loadCapabilities()}
            onToggleSkill={(skill, enabled) =>
              void setSkillEnabled(skill, enabled)
            }
            onToggleToolset={(toolset, enabled) =>
              void setToolsetEnabled(toolset, enabled)
            }
          />
        ) : panel === "messaging" ? (
          <MessagingPanel
            loading={loading}
            platforms={platforms}
            query={query}
            saving={saving}
            selectedPlatformId={selectedPlatformId}
            envEdits={envEdits}
            onQueryChange={setQuery}
            onRefresh={() => void loadMessagingPlatforms()}
            onSelectPlatform={(platform) => {
              setSelectedPlatformId(platform.id);
              setEnvEdits({});
            }}
            onEditEnv={(key, value) =>
              setEnvEdits((current) => ({ ...current, [key]: value }))
            }
            onSaveEnv={(platform) => void saveMessagingPlatformEnv(platform)}
            onToggle={(platform, enabled) =>
              void setMessagingPlatformEnabled(platform, enabled)
            }
          />
        ) : (
          <FilesystemPanel
            loading={loading}
            query={query}
            snapshot={filesystemSnapshot}
            onQueryChange={setQuery}
            onRefresh={() => void loadFilesystemSnapshot()}
          />
        )}
      </div>
    </section>
  );
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unable to update agent settings.";
}
