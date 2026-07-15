import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  FilesystemPanel,
  MessagingPanel,
  MessagingPlatformDetail,
  messagingTrimEdits,
} from "../agent/AgentWorkspace";
import { BreadcrumbBar } from "../ui/BreadcrumbBar";
import { HoverTip } from "../ui/HoverTip";
import {
  hermesAgentCliAccess,
  hermesBridgeFilesystemSnapshot,
  hermesBridgeMessagingPlatforms,
  agentHudHide,
  agentHudShow,
  juneCharacter,
  revealPath,
  setHermesAgentCliAccess,
  setJuneCharacter,
  updateHermesBridgeMessagingPlatform,
  type HermesMessagingPlatformInfo,
  type HermesFilesystemSnapshot,
  type JuneCharacterStatus,
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
import { withTimeout } from "../../lib/async-timeout";
import {
  MESSAGING_PLATFORMS_LOAD_TIMEOUT_MESSAGE,
  MESSAGING_PLATFORMS_LOAD_TIMEOUT_MS,
} from "../../lib/hermes-messaging";
import { Switch } from "../ui/Switch";
import { SettingsPageHeader } from "./AppSettings";

type AgentSettingsPanel = "messaging" | "files";

export function AgentSettingsSection({
  selectedPlatformId,
  onSelectPlatform,
  onBackFromPlatform,
}: {
  /** The messaging platform whose detail is open, lifted into AppSettings so the
   * drill-in can pin at the very top of the settings surface (replacing the
   * settings page), exactly like an opened skill. Undefined shows the list. */
  selectedPlatformId?: string;
  /** Drill into a platform. */
  onSelectPlatform?: (platformId: string) => void;
  /** Return to the platform list. */
  onBackFromPlatform?: () => void;
} = {}) {
  // Messaging / Files present as the system underline tabs (same pattern as
  // the routine detail tabs), with the active panel's content beneath.
  const [panel, setPanel] = useState<AgentSettingsPanel>("messaging");
  const messagingTabRef = useRef<HTMLButtonElement | null>(null);
  const filesTabRef = useRef<HTMLButtonElement | null>(null);
  const [tabIndicator, setTabIndicator] = useState({ x: 0, width: 0 });
  const [query, setQuery] = useState("");
  const [filesQuery, setFilesQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [platforms, setPlatforms] = useState<HermesMessagingPlatformInfo[] | null>(null);
  const [filesystemSnapshot, setFilesystemSnapshot] = useState<HermesFilesystemSnapshot | null>(
    null,
  );
  const [envEdits, setEnvEdits] = useState<Record<string, string>>({});
  const [agentHudEnabled, setAgentHudEnabledState] = useState(() => getAgentHudEnabled());
  const [agentSoundsEnabled, setAgentSoundsEnabledState] = useState(() => getAgentSoundsEnabled());
  // null until the stored value loads, so the switch never flashes a wrong
  // default for a setting with security weight.
  const [cliAccessEnabled, setCliAccessEnabled] = useState<boolean | null>(null);
  const [cliAccessSaving, setCliAccessSaving] = useState(false);
  const [cliAccessLoadFailed, setCliAccessLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    hermesAgentCliAccess()
      .then((status) => {
        if (!cancelled) {
          setCliAccessEnabled(status.enabled);
          setCliAccessLoadFailed(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setCliAccessLoadFailed(true);
          setError(messageFromError(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleAgentSoundsChanged(event: Event) {
      const detail = (event as CustomEvent<AgentSoundsChangedDetail>).detail;
      if (detail) setAgentSoundsEnabledState(detail.enabled);
    }

    window.addEventListener(AGENT_SOUNDS_CHANGED_EVENT, handleAgentSoundsChanged);
    return () => {
      window.removeEventListener(AGENT_SOUNDS_CHANGED_EVENT, handleAgentSoundsChanged);
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

  async function handleCliAccessRetry() {
    setCliAccessSaving(true);
    setCliAccessLoadFailed(false);
    try {
      const status = await hermesAgentCliAccess();
      setCliAccessEnabled(status.enabled);
      setError(null);
    } catch (err) {
      setCliAccessLoadFailed(true);
      setError(messageFromError(err));
    } finally {
      setCliAccessSaving(false);
    }
  }

  // Both panels load on mount so switching tabs is instant.
  useEffect(() => {
    if (!platforms) void loadMessagingPlatforms();
    if (!filesystemSnapshot) void loadFilesystemSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    function updateIndicator() {
      const tab = panel === "messaging" ? messagingTabRef.current : filesTabRef.current;
      if (!tab) return;
      setTabIndicator({ x: tab.offsetLeft, width: tab.offsetWidth });
    }
    updateIndicator();
    window.addEventListener("resize", updateIndicator);
    return () => window.removeEventListener("resize", updateIndicator);
  }, [panel]);

  useEffect(() => {
    function handleVisibilityChanged(event: Event) {
      const detail = (event as CustomEvent<AgentHudVisibilityChangedDetail>).detail;
      if (detail) setAgentHudEnabledState(detail.enabled);
    }

    window.addEventListener(AGENT_HUD_VISIBILITY_CHANGED_EVENT, handleVisibilityChanged);
    return () => {
      window.removeEventListener(AGENT_HUD_VISIBILITY_CHANGED_EVENT, handleVisibilityChanged);
    };
  }, []);

  async function handleAgentHudEnabledChange(enabled: boolean) {
    setAgentHudEnabledState(enabled);
    setAgentHudEnabled(enabled);
    try {
      if (enabled) {
        await agentHudShow();
      } else {
        await agentHudHide();
      }
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function loadMessagingPlatforms() {
    setLoading(true);
    try {
      const response = await withTimeout(
        hermesBridgeMessagingPlatforms(),
        MESSAGING_PLATFORMS_LOAD_TIMEOUT_MS,
        MESSAGING_PLATFORMS_LOAD_TIMEOUT_MESSAGE,
      );
      setPlatforms(response.platforms);
      // Selection is a drill-in, not a default: if the open platform no longer
      // exists after a reload, fall back to the list.
      if (
        selectedPlatformId &&
        !response.platforms.some((item) => item.id === selectedPlatformId)
      ) {
        onBackFromPlatform?.();
      }
      setError(null);
    } catch (err) {
      setPlatforms((current) => current ?? []);
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
        roots: snapshot.roots.filter((root) => root.id === "workspace" || root.id === "memory"),
      });
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setLoading(false);
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
          current?.map((item) => (item.id === platform.id ? { ...item, enabled } : item)) ??
          current,
      );
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(null);
    }
  }

  async function saveMessagingPlatformEnv(platform: HermesMessagingPlatformInfo) {
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

  const selectedPlatform =
    (selectedPlatformId && platforms?.find((item) => item.id === selectedPlatformId)) || null;

  // The messaging platform drill-in fills the screen exactly like skill detail:
  // a pinned BreadcrumbBar ("Messaging" > platform name) over a dedicated scroll
  // region, the outer settings scroller disabled by the host. Reuses the shared
  // skill-detail shell classes rather than forking a parallel CSS system. Its
  // Save + enable switch live in the breadcrumb bar (right side), exactly like
  // the skills detail put Save + the switch there — no separate footer.
  //
  // When the host mounts this fresh at the top level with a platform id but the
  // roster hasn't loaded yet, render the pinned shell with a clean skeleton
  // instead of falling through to the full list + tabs — that fall-through would
  // flash the list for a frame before the platform resolves.
  const detailOpen = selectedPlatformId != null;
  if (detailOpen) {
    const back = () => {
      onBackFromPlatform?.();
      setEnvEdits({});
    };
    const platformName = selectedPlatform?.name ?? "Platform";
    const hasEdits = Object.values(messagingTrimEdits(envEdits)).length > 0;
    const isSavingEnv = saving === `env:${selectedPlatformId}`;
    const isToggling = saving === `messaging:${selectedPlatformId}`;
    const pending = !selectedPlatform;
    return (
      <div className="skill-detail-shell">
        <BreadcrumbBar
          backLabel="Back to messaging platforms"
          onBack={back}
          items={[{ label: "Messaging", onClick: back }, { label: selectedPlatform?.name ?? "" }]}
          actions={
            selectedPlatform ? (
              <>
                <Switch
                  checked={Boolean(selectedPlatform.enabled)}
                  disabled={isToggling}
                  onCheckedChange={(next) =>
                    void setMessagingPlatformEnabled(selectedPlatform, next)
                  }
                  aria-label={`${selectedPlatform.enabled ? "Disable" : "Enable"} ${platformName}`}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={!hasEdits || isSavingEnv}
                  onClick={() => void saveMessagingPlatformEnv(selectedPlatform)}
                >
                  {isSavingEnv ? "Saving..." : "Save changes"}
                </button>
              </>
            ) : null
          }
        />
        <div className="skill-detail-scroll" data-has-detail-bar="true">
          <section
            className="settings-page settings-group agent-messaging-detail-page"
            aria-label={platformName}
          >
            {pending ? (
              <div className="agent-messaging-detail-skeleton" aria-hidden>
                <span className="agent-messaging-detail-skeleton-title" />
                <span className="agent-messaging-detail-skeleton-line" />
                <span className="agent-messaging-detail-skeleton-line" />
              </div>
            ) : (
              <MessagingPlatformDetail
                envEdits={envEdits}
                platform={selectedPlatform}
                saving={saving}
                hideFooter
                onEditEnv={(key, value) => setEnvEdits((current) => ({ ...current, [key]: value }))}
                onSaveEnv={(platform) => void saveMessagingPlatformEnv(platform)}
                onToggle={(platform, enabled) =>
                  void setMessagingPlatformEnabled(platform, enabled)
                }
              />
            )}
          </section>
        </div>
      </div>
    );
  }

  return (
    <>
      <section className="settings-group" aria-labelledby="agent-heading">
        <SettingsPageHeader
          id="agent-heading"
          title="Agent"
          blurb="Configure how the June agent runs on this Mac."
        />
        <div className="settings-card">
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Sessions HUD</h3>
                <p className="settings-row-description">
                  Show a small pill at the top right of your screen with live session status.
                </p>
              </div>
              <div className="settings-row-control">
                <Switch
                  checked={agentHudEnabled}
                  onCheckedChange={(enabled) => void handleAgentHudEnabledChange(enabled)}
                  aria-label="Show sessions HUD"
                />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Agent sounds</h3>
                <p className="settings-row-description">
                  Play a sound when June finishes or needs your attention.
                </p>
              </div>
              <div className="settings-row-control">
                <Switch
                  checked={agentSoundsEnabled}
                  onCheckedChange={(enabled) => {
                    setAgentSoundsEnabledState(enabled);
                    setAgentSoundsEnabled(enabled);
                  }}
                  aria-label="Play agent sounds"
                />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title settings-row-title-with-info">
                  Agent CLI access
                  <HoverTip
                    className="settings-row-info-tip"
                    tip={
                      <>
                        Sandboxed sessions gain write access to those CLIs' own settings and session
                        folders. Some CLIs (Codex among them) will not even start without it; others
                        lose their login. Those folders configure software that also runs outside
                        June's sandbox, so leave this off unless you want June operating your CLIs.
                        Applies to new sessions.
                      </>
                    }
                    width={320}
                  >
                    <span
                      className="settings-row-info-affordance"
                      tabIndex={0}
                      role="note"
                      aria-label="Agent CLI access details"
                    >
                      <IconCircleInfo size={13} ariaHidden />
                    </span>
                  </HoverTip>
                </h3>
                <p className="settings-row-description">
                  Let June drive the coding CLIs you already use, like Claude Code and Codex.
                </p>
              </div>
              <div className="settings-row-control">
                {cliAccessLoadFailed ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={cliAccessSaving}
                    onClick={() => void handleCliAccessRetry()}
                  >
                    {cliAccessSaving ? "Trying again..." : "Try again"}
                  </button>
                ) : (
                  <Switch
                    checked={cliAccessEnabled === true}
                    disabled={cliAccessEnabled === null || cliAccessSaving}
                    onCheckedChange={(enabled) => void handleCliAccessChange(enabled)}
                    aria-label="Allow agent CLI access"
                  />
                )}
              </div>
            </div>
          </div>
        </div>
        {error ? <p className="settings-row-error">{error}</p> : null}
      </section>
      <CharacterGroup />
      <MessagingGroup
        loading={loading}
        platforms={platforms}
        query={query}
        saving={saving}
        selectedPlatformId={selectedPlatformId}
        envEdits={envEdits}
        onQueryChange={setQuery}
        onRefresh={() => void loadMessagingPlatforms()}
        onSelectPlatform={(platform) => {
          onSelectPlatform?.(platform.id);
          setEnvEdits({});
        }}
        onBack={() => {
          onBackFromPlatform?.();
          setEnvEdits({});
        }}
        onEditEnv={(key, value) => setEnvEdits((current) => ({ ...current, [key]: value }))}
        onSaveEnv={(platform) => void saveMessagingPlatformEnv(platform)}
        onToggle={(platform, enabled) => void setMessagingPlatformEnabled(platform, enabled)}
      />
      <FilesGroup
        loading={loading}
        query={filesQuery}
        snapshot={filesystemSnapshot}
        onQueryChange={setFilesQuery}
        onRefresh={() => void loadFilesystemSnapshot()}
      />
    </>
  );
}

/** Mirrors JUNE_CHARACTER_MAX_CHARS on the Rust side. */
const CHARACTER_MAX_LENGTH = 4000;

/** The character group: June's editable personality text, backed by
 * CHARACTER.md in the agent home. Only the personality is editable here;
 * identity, privacy, and tool instructions stay app-owned. The file link
 * keeps the direct-editing path discoverable. */
function CharacterGroup() {
  const [status, setStatus] = useState<JuneCharacterStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    juneCharacter()
      .then((loaded) => {
        if (cancelled) return;
        setStatus(loaded);
        setDraft(loaded.character);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(messageFromError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = status !== null && draft.trim() !== status.character.trim();

  async function save(character: string) {
    setSaving(true);
    try {
      const next = await setJuneCharacter(character);
      setStatus(next);
      setDraft(next.character);
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-group" aria-labelledby="agent-character-heading">
      <h2 id="agent-character-heading" className="settings-group-heading">
        Character
      </h2>
      <p className="settings-group-description">
        How June talks and behaves in agent sessions. Rewrite it freely; June's identity, privacy
        rules, and tool instructions stay the same. Saved to CHARACTER.md, which you can also edit
        directly. Applies to new sessions.
      </p>
      <div className="settings-card agent-character-card">
        <textarea
          className="agent-character-editor"
          value={draft}
          rows={6}
          maxLength={CHARACTER_MAX_LENGTH}
          aria-label="June's character"
          disabled={status === null}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <div className="agent-character-actions">
          <button
            type="button"
            className="btn"
            disabled={!dirty || saving}
            onClick={() => void save(draft)}
          >
            {saving ? "Saving..." : "Save character"}
          </button>
          {status?.isCustom || (status !== null && dirty) ? (
            <button type="button" className="btn" disabled={saving} onClick={() => void save("")}>
              Reset to default
            </button>
          ) : null}
          {status ? (
            <button
              type="button"
              className="btn"
              onClick={() =>
                void revealPath(status.path).catch((err: unknown) =>
                  setError(messageFromError(err)),
                )
              }
            >
              Show file
            </button>
          ) : null}
        </div>
        {error ? <p className="settings-row-error">{error}</p> : null}
      </div>
    </section>
  );
}

/** The messaging channels group: a quiet platform list (name, status, toggle)
 * with per-platform configuration behind a drill-in, matching how the rest of
 * settings surfaces detail views. Section title lives outside the card like
 * every other settings group. */
function MessagingGroup({
  loading,
  platforms,
  query,
  saving,
  selectedPlatformId,
  envEdits,
  onQueryChange,
  onRefresh,
  onSelectPlatform,
  onBack,
  onEditEnv,
  onSaveEnv,
  onToggle,
}: {
  loading: boolean;
  platforms: HermesMessagingPlatformInfo[] | null;
  query: string;
  saving: string | null;
  selectedPlatformId?: string;
  envEdits: Record<string, string>;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onSelectPlatform: (platform: HermesMessagingPlatformInfo) => void;
  onBack: () => void;
  onEditEnv: (key: string, value: string) => void;
  onSaveEnv: (platform: HermesMessagingPlatformInfo) => void;
  onToggle: (platform: HermesMessagingPlatformInfo, enabled: boolean) => void;
}) {
  return (
    <section
      id="agent-panel-messaging"
      className="settings-group"
      role="tabpanel"
      aria-labelledby="agent-tab-messaging"
    >
      <h2 className="settings-group-heading agent-messaging-heading">
        Platforms
        {platforms ? (
          <span className="status-pill agent-messaging-heading-count">{platforms.length}</span>
        ) : null}
      </h2>
      <p className="settings-group-description">
        Connect messaging platforms so you can reach the agent where you already chat. Select a
        platform to configure it.
      </p>
      <div className="settings-card settings-agent-card settings-agent-card-hug">
        <MessagingPanel
          loading={loading}
          platforms={platforms}
          query={query}
          saving={saving}
          selectedPlatformId={selectedPlatformId}
          envEdits={envEdits}
          onQueryChange={onQueryChange}
          onRefresh={onRefresh}
          onSelectPlatform={onSelectPlatform}
          onBack={onBack}
          onEditEnv={onEditEnv}
          onSaveEnv={onSaveEnv}
          onToggle={onToggle}
        />
      </div>
    </section>
  );
}

/** The filesystem group: what agent sessions can see on disk. */
function FilesGroup({
  loading,
  query,
  snapshot,
  onQueryChange,
  onRefresh,
}: {
  loading: boolean;
  query: string;
  snapshot: HermesFilesystemSnapshot | null;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
}) {
  return (
    <section
      id="agent-panel-files"
      className="settings-group"
      role="tabpanel"
      aria-labelledby="agent-tab-files"
    >
      <p className="settings-group-description">
        The folders agent sessions can read and write on this Mac.
      </p>
      {/* No outer card: the search + refresh toolbar sits bare above, and each
       * root (Workspace, Memory) provides its own wrapping card. */}
      <FilesystemPanel
        loading={loading}
        query={query}
        snapshot={snapshot}
        onQueryChange={onQueryChange}
        onRefresh={onRefresh}
      />
    </section>
  );
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unable to update agent settings.";
}
