import { useEffect, useState } from "react";
import {
  FilesystemPanel,
  MessagingPanel,
  SkillsToolsPanel,
} from "../agent/AgentWorkspace";
import {
  hermesAgentCliAccess,
  hermesBridgeFilesystemSnapshot,
  hermesBridgeMessagingPlatforms,
  hermesBridgeSkills,
  hermesBridgeToolsets,
  agentHudHide,
  setHermesAgentCliAccess,
  toggleHermesBridgeSkill,
  toggleHermesBridgeToolset,
  updateHermesBridgeMessagingPlatform,
  type HermesMessagingPlatformInfo,
  type HermesSkillInfo,
  type HermesToolsetInfo,
  type HermesFilesystemSnapshot,
} from "../../lib/tauri";
import {
  AGENT_HUD_VISIBILITY_CHANGED_EVENT,
  getAgentHudEnabled,
  setAgentHudEnabled,
  type AgentHudVisibilityChangedDetail,
} from "../../lib/agent-hud-settings";
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
  const [agentHudEnabled, setAgentHudEnabledState] = useState(() =>
    getAgentHudEnabled(),
  );
  // null until the stored value loads, so the switch never flashes a wrong
  // default for a setting with security weight.
  const [cliAccessEnabled, setCliAccessEnabled] = useState<boolean | null>(
    null,
  );
  const [cliAccessSaving, setCliAccessSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    hermesAgentCliAccess()
      .then((status) => {
        if (!cancelled) setCliAccessEnabled(status.enabled);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(messageFromError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCliAccessChange(enabled: boolean) {
    setCliAccessSaving(true);
    try {
      const status = await setHermesAgentCliAccess(enabled);
      setCliAccessEnabled(status.enabled);
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setCliAccessSaving(false);
    }
  }

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
      const detail = (event as CustomEvent<AgentHudVisibilityChangedDetail>)
        .detail;
      if (detail) setAgentHudEnabledState(detail.enabled);
    }

    window.addEventListener(
      AGENT_HUD_VISIBILITY_CHANGED_EVENT,
      handleVisibilityChanged,
    );
    return () => {
      window.removeEventListener(
        AGENT_HUD_VISIBILITY_CHANGED_EVENT,
        handleVisibilityChanged,
      );
    };
  }, []);

  async function handleAgentHudEnabledChange(enabled: boolean) {
    setAgentHudEnabledState(enabled);
    setAgentHudEnabled(enabled);
    try {
      if (!enabled) {
        await agentHudHide();
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
              <h3 className="settings-row-title">Agent HUD</h3>
              <p className="settings-row-description">
                Show a small pill at the top right of your screen with live
                agent session status.
              </p>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={agentHudEnabled}
                onCheckedChange={(enabled) =>
                  void handleAgentHudEnabledChange(enabled)
                }
                aria-label="Show agent HUD"
              />
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">Agent CLI access</h3>
              <p className="settings-row-description">
                Let June drive the coding CLIs you already use (Claude Code,
                Codex, Gemini, opencode). Sandboxed sessions gain write access
                to those tools' own settings and session folders so they stay
                logged in and can save their work. Those folders configure
                software that also runs outside June's sandbox, so leave this
                off unless you want June operating your CLIs. Applies to new
                sessions.
              </p>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={cliAccessEnabled === true}
                disabled={cliAccessEnabled === null || cliAccessSaving}
                onCheckedChange={(enabled) =>
                  void handleCliAccessChange(enabled)
                }
                aria-label="Allow agent CLI access"
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
