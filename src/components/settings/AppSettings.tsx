import { listen } from "@tauri-apps/api/event";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCircleQuestionmark } from "central-icons/IconCircleQuestionmark";
import { IconCircleX } from "central-icons/IconCircleX";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconMoonStar } from "central-icons/IconMoonStar";
import { IconSun } from "central-icons/IconSun";
import { IconTelevision } from "central-icons/IconTelevision";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  JUNE_COMMUNITY_URL,
  dictationHelperCommand,
  dictationSettings,
  listVeniceModels,
  localAudioFileSrc,
  providerModelSettings,
  juneOpenCommunityPage,
  juneOpenVerifyPage,
  clearVeniceApiKey,
  setDictationLanguage,
  setDictationMicrophone,
  setDictationShortcut,
  setVeniceApiKey,
  setVeniceModel,
} from "../../lib/tauri";
import { LANGUAGE_OPTIONS, languageLabel } from "../../lib/dictation-languages";
import { replayOnboarding } from "../../lib/onboarding";
import type {
  AccountStatus,
  DictationHelperEvent,
  DictationMicrophoneDeviceDto,
  DictationShortcutKind,
  DictationSettingsDto,
  DictationShortcutModifiers,
  DictationShortcutSetting,
  ProviderModelMode,
  ProviderModelSettingsDto,
  RecordingSourceMode,
  RecordingSourceReadinessDto,
  VeniceModelDto,
} from "../../lib/tauri";
import { AccountSettingsSection, BillingSettingsSection } from "../account/AccountSettings";
import { KeycapShortcut } from "../shortcuts/KeycapShortcut";
import {
  MODIFIER_REQUIRED_MESSAGE,
  chordFromKeyEvent,
  shortcutFromCapturePayload,
} from "../shortcuts/use-shortcut-capture";
import {
  selectPopoverPlacement,
  selectPopoverStyle,
  type SelectPopoverPlacement,
} from "../ui/Select";
import { SegmentedControl } from "../ui/SegmentedControl";
import { InlineNotice } from "../ui/InlineNotice";
import { Switch } from "../ui/Switch";
import { APP_COMMIT_HASH, APP_VERSION } from "../../app/build-info";
import type { ReportCategory } from "../agent/composer/reportCategory";
import { getStoredTheme, setStoredTheme, type ThemePreference } from "../../lib/theme";
import { DEFAULT_BRAND, getStoredBrand, setStoredBrand, type BrandId } from "../../lib/brand";
import { AccentWheel } from "./AccentWheel";
import {
  getReleaseChannel,
  reconcileToStable,
  setReleaseChannel,
  type ReleaseChannel,
} from "../../lib/updater";
import { isMacLikePlatform } from "../../lib/platform";
import { parseDictationHelperEvent } from "../../lib/dictation-events";
import { dispatchProviderModelSettingsChanged } from "../../lib/model-privacy";
import { ProviderLogo } from "./ProviderLogo";
import { ModelMeta, ModelPickerDialog, modelOptions, selectedModel } from "./ModelPickerDialog";
import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from "../../lib/image-models";
import { IMAGE_GENERATION_ENABLED } from "../../lib/feature-flags";
import { AgentSettingsSection } from "./AgentSettingsSection";
import { ExternalDirsSection } from "./ExternalDirsSection";
import { InstalledSkillsSection } from "./InstalledSkillsSection";
import { SkillReviewSection } from "./SkillReviewSection";
import { McpCatalogSection } from "./McpCatalogSection";
import { McpDiagnosticsSection } from "./McpDiagnosticsSection";
import { McpSecuritySection } from "./McpSecuritySection";
import { McpServersSection } from "./McpServersSection";
import {
  IntegrationsHealthSection,
  type IntegrationsHealthTarget,
} from "./IntegrationsHealthSection";
import { ProfileBuilderSection } from "./ProfileBuilderSection";
import { SetupSnapshotSection } from "./SetupSnapshotSection";
import { SkillBundlesSection } from "./SkillBundlesSection";
import { SkillsHubSection } from "./SkillsHubSection";
import { TeamTapsSection } from "./TeamTapsSection";
import { ToolsetsSection } from "./ToolsetsSection";
import { DictionarySettingsSection } from "./DictionarySettingsSection";
import { MicTestControl, type MicTestState } from "./MicTestControl";
import { StyleSettingsSection } from "./StyleSettingsSection";

const THEME_OPTIONS: readonly {
  value: ThemePreference;
  label: ReactNode;
  ariaLabel: string;
}[] = [
  {
    value: "system",
    label: (
      <>
        <IconTelevision size={14} />
        System
      </>
    ),
    ariaLabel: "Match system theme",
  },
  {
    value: "light",
    label: (
      <>
        <IconSun size={14} />
        Light
      </>
    ),
    ariaLabel: "Use light theme",
  },
  {
    value: "dark",
    label: (
      <>
        <IconMoonStar size={14} />
        Dark
      </>
    ),
    ariaLabel: "Use dark theme",
  },
];

const RELEASE_CHANNEL_OPTIONS: readonly {
  value: ReleaseChannel;
  label: ReactNode;
}[] = [
  { value: "stable", label: "Stable" },
  { value: "rc", label: "Release candidate" },
];

const EMPTY_MODIFIERS: DictationShortcutModifiers = {
  command: false,
  control: false,
  option: false,
  shift: false,
  function: false,
};

const DEFAULT_SETTINGS: DictationSettingsDto = {
  pushToTalkShortcut: {
    keyCode: 0x02,
    code: "KeyD",
    label: "Ctrl+Opt+D",
    pressCount: 1,
    modifiers: {
      ...EMPTY_MODIFIERS,
      control: true,
      option: true,
    },
  },
  toggleShortcut: {
    keyCode: 0x11,
    code: "KeyT",
    label: "Ctrl+Opt+T",
    pressCount: 1,
    modifiers: {
      ...EMPTY_MODIFIERS,
      control: true,
      option: true,
    },
  },
  microphone: {},
  style: "standard",
  language: undefined,
};

const DEFAULT_SHORTCUTS: Record<DictationShortcutKind, DictationShortcutSetting> = {
  push_to_talk: DEFAULT_SETTINGS.pushToTalkShortcut,
  toggle: DEFAULT_SETTINGS.toggleShortcut,
};

const DEFAULT_PROVIDER_MODELS: ProviderModelSettingsDto = {
  transcriptionProvider: "venice",
  transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
  // Mirrors DEFAULT_GENERATION_MODEL in the Rust providers module and the
  // leading Suggested pick in lib/suggested-models.ts.
  generationModel: "zai-org-glm-5-2",
  // Mirrors DEFAULT_IMAGE_MODEL in the Rust providers module.
  imageModel: DEFAULT_IMAGE_MODEL,
  veniceApiKeyConfigured: false,
};

const MIC_TEST_DURATION_SECONDS = 5;

export type SettingsTab =
  | "general"
  | "billing"
  | "shortcuts"
  | "dictation"
  | "audio"
  | "models"
  | "agent"
  | "skills"
  | "external-dirs"
  | "skill-review"
  | "mcp"
  | "mcp-catalog"
  | "mcp-diagnostics"
  | "mcp-security"
  | "skills-hub"
  | "taps"
  | "toolsets"
  | "bundles"
  | "profile-builder"
  | "integrations-health"
  | "import-export"
  | "about";

export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "billing", label: "Billing" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "dictation", label: "Dictation" },
  { id: "audio", label: "Audio" },
  { id: "models", label: "Models" },
  { id: "agent", label: "Agent" },
  { id: "skills", label: "Installed skills" },
  { id: "external-dirs", label: "External skill directories" },
  { id: "skill-review", label: "Pending skill changes" },
  { id: "mcp", label: "MCP servers" },
  { id: "mcp-catalog", label: "MCP catalog" },
  { id: "mcp-diagnostics", label: "MCP diagnostics" },
  { id: "mcp-security", label: "MCP security" },
  { id: "skills-hub", label: "Skills hub" },
  { id: "taps", label: "Team skill taps" },
  { id: "toolsets", label: "Toolsets" },
  { id: "bundles", label: "Bundles" },
  { id: "profile-builder", label: "Profile builder" },
  { id: "integrations-health", label: "Integrations health" },
  { id: "import-export", label: "Import / export" },
  { id: "about", label: "About" },
];

type AppSettingsProps = {
  account: AccountStatus;
  accountLoading: boolean;
  sourceMode: RecordingSourceMode;
  sourceReadiness?: RecordingSourceReadinessDto;
  checkingSourceReadiness: boolean;
  microphonePermissionStatus?: string;
  accessibilityPermissionStatus?: string;
  onAccountChanged: (next: AccountStatus) => void;
  onAccountRefresh: () => Promise<AccountStatus | undefined>;
  onSourceModeChange: (mode: RecordingSourceMode) => void;
  onEnableMicrophone?: () => void;
  onEnableAccessibility?: () => void;
  onEnableSystemAudio: () => void;
  // When the host (the sidebar settings nav) drives the active section, it
  // passes both of these so AppSettings becomes a controlled panel and hides
  // its own header + in-page tab nav. Left undefined, AppSettings keeps its
  // own nav — the standalone path exercised by app-settings tests.
  activeTab?: SettingsTab;
  onTabChange?: (tab: SettingsTab) => void;
  // Runs the app updater's manual check flow.
  onCheckForUpdates?: () => void;
  // Confirmed leave-rc reconcile: downloads and installs the current stable,
  // even if it is older than the running prerelease build (Q4-Q8).
  onReconcileToStable?: () => void;
  // Opens a new agent session seeded with a report category chip.
  onReportIssue?: (category: ReportCategory) => void;
  // Opens a new agent session that runs a skill bundle's slash command.
  onStartBundleChat?: (prompt: string) => void;
};

export function AppSettings({
  account,
  accountLoading,
  sourceMode,
  sourceReadiness,
  checkingSourceReadiness,
  microphonePermissionStatus,
  accessibilityPermissionStatus,
  onAccountChanged,
  onAccountRefresh,
  onSourceModeChange,
  onEnableMicrophone,
  onEnableAccessibility,
  onEnableSystemAudio,
  activeTab: controlledTab,
  onTabChange,
  onCheckForUpdates,
  onReconcileToStable,
  onReportIssue,
  onStartBundleChat,
}: AppSettingsProps) {
  const [settings, setSettings] = useState<DictationSettingsDto>(DEFAULT_SETTINGS);
  const [providerSettings, setProviderSettings] =
    useState<ProviderModelSettingsDto>(DEFAULT_PROVIDER_MODELS);
  const [veniceModels, setVeniceModels] = useState<Record<ProviderModelMode, VeniceModelDto[]>>({
    transcription: [],
    generation: [],
    // Image options come from a curated local list, not the fetched catalog;
    // this stays empty and `imageOptions` supplies the picker.
    image: [],
  });
  const [microphones, setMicrophones] = useState<DictationMicrophoneDeviceDto[]>([]);
  const [defaultMicrophone, setDefaultMicrophone] = useState<DictationMicrophoneDeviceDto>();
  const [capturingShortcut, setCapturingShortcut] = useState<DictationShortcutKind>();
  const capturingShortcutRef = useRef<DictationShortcutKind>();
  const [shortcutError, setShortcutError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [micOpen, setMicOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(() => getStoredTheme());
  const [brand, setBrand] = useState<BrandId>(() => getStoredBrand());
  const [releaseChannel, setReleaseChannelValue] = useState<ReleaseChannel>("stable");
  // Set only when a leave-rc switch turns up an installable stable, so the
  // bespoke in-context confirm below the toggle can name the exact version.
  const [reconcileVersion, setReconcileVersion] = useState<string>();
  const [pickerMode, setPickerMode] = useState<ProviderModelMode>();
  const [modelSearch, setModelSearch] = useState("");
  const [veniceApiKeyDraft, setVeniceApiKeyDraft] = useState("");
  const [showMoreModelOptions, setShowMoreModelOptions] = useState(false);
  const [internalTab, setInternalTab] = useState<SettingsTab>("general");
  const [micPopoverPlacement, setMicPopoverPlacement] =
    useState<SelectPopoverPlacement>("align-selected");
  const [languageOpen, setLanguageOpen] = useState(false);
  const [languagePopoverPlacement, setLanguagePopoverPlacement] =
    useState<SelectPopoverPlacement>("align-selected");
  const [micTestState, setMicTestState] = useState<MicTestState>("idle");
  const [micTestLevel, setMicTestLevel] = useState(0);
  const [micTestStartedAt, setMicTestStartedAt] = useState<number>();
  const [micTestElapsedMs, setMicTestElapsedMs] = useState(0);
  const [micTestSampleSrc, setMicTestSampleSrc] = useState<string>();
  const [micTestError, setMicTestError] = useState<string>();
  const [micTestPlaying, setMicTestPlaying] = useState(false);
  const controlled = controlledTab !== undefined && onTabChange !== undefined;
  const activeTab = controlled ? controlledTab : internalTab;
  const settingsTabs = account.localDev
    ? SETTINGS_TABS.filter((tab) => tab.id !== "billing")
    : SETTINGS_TABS;
  const macLikePlatform = isMacLikePlatform();
  const setActiveTab = (tab: SettingsTab) => {
    if (controlled) {
      onTabChange?.(tab);
    } else {
      setInternalTab(tab);
    }
  };
  const micWrapRef = useRef<HTMLDivElement>(null);
  const languageWrapRef = useRef<HTMLDivElement>(null);
  const systemOn = sourceMode === "microphonePlusSystem";
  const systemReadiness = sourceReadiness?.sources.find((source) => source.source === "system");
  const microphoneReadiness = sourceReadiness?.sources.find(
    (source) => source.source === "microphone",
  );
  const systemState = systemReadiness?.permissionState;
  const systemDenied = systemState === "denied" || systemState === "restricted";
  const systemUnavailable = !macLikePlatform || systemState === "unsupported";

  useEffect(() => {
    capturingShortcutRef.current = capturingShortcut;
  }, [capturingShortcut]);

  // Load the persisted release channel once the updater is available. Gated on
  // a stable boolean (not the onCheckForUpdates prop itself, which is an inline
  // arrow with a new identity each render) so this loads once, not per render.
  const updaterAvailable = Boolean(onCheckForUpdates);
  useEffect(() => {
    if (!updaterAvailable) return;
    let active = true;
    void getReleaseChannel()
      .then((channel) => {
        if (active) setReleaseChannelValue(channel);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [updaterAvailable]);

  const handleReleaseChannelChange = (next: ReleaseChannel) => {
    setReleaseChannelValue(next);
    // Any channel change dismisses a stale reconcile offer (e.g. toggling back
    // to rc, or stable -> rc -> stable) before we decide whether to re-offer.
    setReconcileVersion(undefined);
    void setReleaseChannel(next)
      .then(() => {
        // Leaving rc for stable while running a prerelease build: stable is
        // normally older than the rc you are on, so a routine check would never
        // pull it. Offer a one-time reconcile down onto the current stable (Q4-Q8).
        if (next === "stable" && isPrereleaseBuild()) {
          void offerReconcileToStable();
        }
      })
      .catch(() => {
        // Persist failed: re-read so the toggle reflects the real saved channel
        // rather than an optimistic value that never reached disk.
        void getReleaseChannel()
          .then(setReleaseChannelValue)
          .catch(() => undefined);
      });
  };

  async function offerReconcileToStable() {
    try {
      const update = await reconcileToStable();
      // Only prompt when a stable is actually installable. If stable has already
      // caught up or passed the rc, the routine updater handles it (no reconcile).
      if (update) setReconcileVersion(update.version);
    } catch {
      // A failed reconcile check is silent: the channel is already saved and the
      // routine update flow will retry on its next check.
    }
  }

  function confirmReconcileToStable() {
    setReconcileVersion(undefined);
    onReconcileToStable?.();
  }

  useEffect(() => {
    setMicOpen(false);
    setLanguageOpen(false);
    if (activeTab !== "audio" && micTestState !== "idle") {
      void resetMicTestState(true);
    }
  }, [activeTab]);

  useEffect(() => {
    if (!account.localDev || activeTab !== "billing") {
      return;
    }
    if (controlled) {
      onTabChange?.("general");
      return;
    }
    setInternalTab("general");
  }, [account.localDev, activeTab, controlled, onTabChange]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    async function boot() {
      try {
        const response = await dictationSettings();
        if (cancelled) return;
        setSettings(response.settings);
        const modelResponse = await providerModelSettings();
        if (cancelled) return;
        // Merge over defaults so a settings payload that predates a field
        // (e.g. imageModel from an older backend) still has every model set.
        setProviderSettings({
          ...DEFAULT_PROVIDER_MODELS,
          ...modelResponse.settings,
        });
        await requestMicrophones();
        await Promise.all([
          requestVeniceModels("transcription"),
          requestVeniceModels("generation"),
        ]);
      } catch (error) {
        if (!cancelled) setStatus(messageFromError(error));
      }
    }

    void listen<string>("dictation-event", (event) => {
      const helperEvent = parseDictationHelperEvent(event.payload);
      if (helperEvent) handleHelperEvent(helperEvent);
    }).then((cleanup) => {
      // Unmount can race the listen() promise — unsubscribe immediately
      // instead of leaking the listener.
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    void boot();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!micOpen) return;
    function onPointer(event: MouseEvent) {
      if (!micWrapRef.current?.contains(event.target as Node)) {
        setMicOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMicOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [micOpen]);

  useEffect(() => {
    if (!languageOpen) return;
    function onPointer(event: MouseEvent) {
      if (!languageWrapRef.current?.contains(event.target as Node)) {
        setLanguageOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setLanguageOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [languageOpen]);

  // The capture effect below must call the latest saveShortcut, not the one
  // from the render in which capturing began (it is a plain function,
  // redefined every render). Same ref pattern as use-shortcut-capture.
  const saveShortcutRef = useRef(saveShortcut);
  useEffect(() => {
    saveShortcutRef.current = saveShortcut;
  });

  useEffect(() => {
    if (!capturingShortcut) return;
    const kind = capturingShortcut;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        void cancelShortcutCapture();
        return;
      }
      // Key chords are read here in the DOM (the window is focused during a
      // rebind); the helper's flagsChanged monitor only contributes fn and
      // bare-modifier chords. This split is what lets the helper run without
      // the Input Monitoring permission.
      const result = chordFromKeyEvent(event);
      if (result.kind === "ignore") return;
      event.preventDefault();
      event.stopPropagation();
      if (result.kind === "needsModifier") {
        setShortcutError(MODIFIER_REQUIRED_MESSAGE);
        setStatus(MODIFIER_REQUIRED_MESSAGE);
        return;
      }
      setShortcutError(undefined);
      void dictationHelperCommand({ type: "cancel_shortcut_capture" }).catch(() => undefined);
      void saveShortcutRef.current(kind, result.shortcut);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturingShortcut]);

  async function requestMicrophones() {
    try {
      await dictationHelperCommand({ type: "list_microphones" });
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function requestVeniceModels(mode: ProviderModelMode) {
    try {
      const response = await listVeniceModels(mode);
      setVeniceModels((models) => ({
        ...models,
        [mode]: response.models,
      }));
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  function handleHelperEvent(helperEvent: DictationHelperEvent) {
    if (helperEvent.type === "microphone_devices") {
      setMicrophones(helperEvent.payload?.devices ?? []);
      setDefaultMicrophone(helperEvent.payload?.defaultDevice);
      return;
    }
    if (helperEvent.type === "mic_test_started") {
      setMicTestState("recording");
      setMicTestError(undefined);
      setMicTestSampleSrc(undefined);
      setMicTestLevel(0);
      setMicTestStartedAt(Date.now());
      setMicTestElapsedMs(0);
      setMicTestPlaying(false);
      return;
    }
    if (helperEvent.type === "mic_test_level") {
      setMicTestLevel(numericPayload(helperEvent.payload?.level));
      return;
    }
    if (helperEvent.type === "mic_test_ready") {
      const path = stringPayload(helperEvent.payload?.path);
      if (!path) {
        setMicTestState("error");
        setMicTestError("Microphone test did not return a playable sample.");
        return;
      }
      setMicTestState("ready");
      setMicTestStartedAt(undefined);
      setMicTestElapsedMs(0);
      setMicTestLevel(numericPayload(helperEvent.payload?.observedAudioLevel));
      setMicTestError(undefined);
      setMicTestPlaying(false);
      setMicTestSampleSrc(localAudioFileSrc(path));
      return;
    }
    if (helperEvent.type === "mic_test_error") {
      const message = helperEvent.payload?.message ?? "Microphone test could not record.";
      setMicTestState("error");
      setMicTestStartedAt(undefined);
      setMicTestError(message);
      setMicTestPlaying(false);
      setStatus(message);
      return;
    }
    if (helperEvent.type === "fn_monitor_unavailable") {
      setStatus(helperEvent.payload?.message ?? "Global shortcut monitoring is unavailable.");
      return;
    }
    if (helperEvent.type === "shortcut_capture_started") {
      setStatus("Press the shortcut to record it.");
      return;
    }
    if (helperEvent.type === "shortcut_capture_error") {
      const message = helperEvent.payload?.message ?? "Shortcut could not be captured.";
      setShortcutError(message);
      setStatus(message);
      return;
    }
    if (helperEvent.type === "shortcut_captured") {
      const kind = capturingShortcutRef.current;
      if (!kind) {
        setShortcutError("Shortcut capture returned without an active target.");
        setStatus("Shortcut capture returned without an active target.");
        return;
      }
      const shortcut = shortcutFromCapturePayload(helperEvent.payload?.shortcut, 1);
      if (!shortcut) {
        setShortcutError("Shortcut capture returned invalid data.");
        setStatus("Shortcut capture returned invalid data.");
        return;
      }
      setShortcutError(undefined);
      void saveShortcut(kind, shortcut);
      return;
    }
    if (helperEvent.type === "error") {
      setStatus(helperEvent.payload?.message ?? "Settings helper failed.");
    }
  }

  async function selectMicrophone(id?: string, name?: string) {
    try {
      if (micTestState !== "idle") {
        await resetMicTestState(true);
      }
      const next = await setDictationMicrophone(id, name);
      setSettings(next);
      setMicOpen(false);
      setStatus(name ? `Microphone set to ${name}.` : "Microphone set to auto-detect.");
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function saveShortcut(
    kind: DictationShortcutKind,
    shortcut: Pick<DictationShortcutSetting, "code" | "modifiers" | "label" | "pressCount">,
  ) {
    try {
      const next = await setDictationShortcut(kind, shortcut);
      setSettings(next);
      setCapturingShortcut(undefined);
      setStatus(`${shortcutKindLabel(kind)} set to ${shortcutForKind(next, kind).label}.`);
    } catch (error) {
      setShortcutError(messageFromError(error));
      setStatus(messageFromError(error));
    }
  }

  async function startShortcutCapture(kind: DictationShortcutKind) {
    setShortcutError(undefined);
    setCapturingShortcut(kind);
    try {
      await dictationHelperCommand({
        type: "start_shortcut_capture",
        pressCount: 1,
      });
    } catch (error) {
      setCapturingShortcut(undefined);
      setShortcutError(messageFromError(error));
      setStatus(messageFromError(error));
    }
  }

  async function cancelShortcutCapture() {
    setCapturingShortcut(undefined);
    setShortcutError(undefined);
    try {
      await dictationHelperCommand({ type: "cancel_shortcut_capture" });
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function startMicTest() {
    setMicTestState("recording");
    setMicTestError(undefined);
    setMicTestSampleSrc(undefined);
    setMicTestLevel(0);
    setMicTestStartedAt(Date.now());
    setMicTestElapsedMs(0);
    setMicTestPlaying(false);
    try {
      await dictationHelperCommand({
        type: "start_mic_test",
        durationSeconds: MIC_TEST_DURATION_SECONDS,
      });
    } catch (error) {
      const message = messageFromError(error);
      setMicTestState("error");
      setMicTestStartedAt(undefined);
      setMicTestError(message);
      setStatus(message);
    }
  }

  async function startOverMicTest() {
    await resetMicTestState(true);
    await startMicTest();
  }

  async function resetMicTestState(discardHelper = false) {
    setMicTestState("idle");
    setMicTestLevel(0);
    setMicTestStartedAt(undefined);
    setMicTestElapsedMs(0);
    setMicTestSampleSrc(undefined);
    setMicTestError(undefined);
    setMicTestPlaying(false);
    if (!discardHelper) return;
    try {
      await dictationHelperCommand({ type: "discard_mic_test" });
    } catch {
      // Resetting the settings UI should not surface stale helper cleanup errors.
    }
  }

  async function selectVeniceModel(mode: ProviderModelMode, modelId: string) {
    try {
      const next = await setVeniceModel(mode, modelId);
      setProviderSettings(next);
      dispatchProviderModelSettingsChanged({ mode, modelId });
      setStatus(
        mode === "transcription"
          ? "Transcription model updated."
          : mode === "image"
            ? "Image model updated."
            : "Text model updated.",
      );
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function saveVeniceApiKey() {
    const apiKey = veniceApiKeyDraft.trim();
    if (!apiKey) {
      setStatus("Enter a Venice API key before saving.");
      return;
    }
    try {
      const next = await setVeniceApiKey(apiKey);
      setProviderSettings(next);
      setVeniceApiKeyDraft("");
      setStatus("Venice API key saved.");
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function removeVeniceApiKey() {
    try {
      const next = await clearVeniceApiKey();
      setProviderSettings(next);
      setVeniceApiKeyDraft("");
      setStatus("Venice API key removed.");
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function selectLanguage(language: string) {
    try {
      const next = await setDictationLanguage(language || undefined);
      setSettings(next);
      setLanguageOpen(false);
      setStatus(
        language
          ? `Default transcription language set to ${languageLabel(language)}.`
          : "Default transcription language set to auto-detect.",
      );
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  const microphoneName = settings.microphone.name ?? "Auto-detect";
  const microphoneDescription = settings.microphone.id
    ? "Input device used for dictation."
    : defaultMicrophone?.name
      ? `Auto-detect uses ${defaultMicrophone.name}.`
      : "Auto-detect uses the current system input.";
  const microphoneOptions = [{ id: undefined, name: "Auto-detect" }, ...microphones];
  const selectedMicrophoneIndex = Math.max(
    0,
    microphoneOptions.findIndex((option) => (option.id ?? "") === (settings.microphone.id ?? "")),
  );
  const selectedLanguageIndex = Math.max(
    0,
    LANGUAGE_OPTIONS.findIndex((option) => option.value === (settings.language ?? "")),
  );
  const transcriptionOptions = modelOptions(
    veniceModels.transcription,
    providerSettings.transcriptionModel,
  );
  const generationOptions = modelOptions(veniceModels.generation, providerSettings.generationModel);
  const imageOptions = IMAGE_GENERATION_ENABLED
    ? modelOptions(IMAGE_MODELS, providerSettings.imageModel)
    : [];
  const pickerOptions = pickerMode ? modelOptionsForMode(pickerMode) : [];
  const pickerValue = pickerMode ? modelValueForMode(pickerMode) : "";

  useEffect(() => {
    if (micOpen) updateMicrophonePopoverPlacement();
  }, [micOpen, microphoneOptions.length, selectedMicrophoneIndex]);

  useEffect(() => {
    if (languageOpen) updateLanguagePopoverPlacement();
  }, [languageOpen, selectedLanguageIndex]);

  useEffect(() => {
    if (micTestState !== "recording" || !micTestStartedAt) return;
    const interval = window.setInterval(() => {
      setMicTestElapsedMs(Date.now() - micTestStartedAt);
    }, 100);
    return () => window.clearInterval(interval);
  }, [micTestState, micTestStartedAt]);

  function updateMicrophonePopoverPlacement() {
    setMicPopoverPlacement(
      selectPopoverPlacement(micWrapRef.current, microphoneOptions.length, selectedMicrophoneIndex),
    );
  }

  function updateLanguagePopoverPlacement() {
    setLanguagePopoverPlacement(
      selectPopoverPlacement(
        languageWrapRef.current,
        LANGUAGE_OPTIONS.length,
        selectedLanguageIndex,
      ),
    );
  }

  function modelOptionsForMode(mode: ProviderModelMode) {
    if (mode === "transcription") return transcriptionOptions;
    if (mode === "image") return IMAGE_GENERATION_ENABLED ? imageOptions : [];
    return generationOptions;
  }

  function modelValueForMode(mode: ProviderModelMode) {
    if (mode === "transcription") return providerSettings.transcriptionModel;
    if (mode === "image") return providerSettings.imageModel;
    return providerSettings.generationModel;
  }

  function openModelPicker(mode: ProviderModelMode) {
    if (mode === "image" && !IMAGE_GENERATION_ENABLED) return;
    setPickerMode(mode);
    setModelSearch("");
    // Image models are a curated local list, not a fetched catalog.
    if (mode !== "image") void requestVeniceModels(mode);
  }

  function microphonePopoverStyle(): CSSProperties {
    return selectPopoverStyle(micPopoverPlacement, selectedMicrophoneIndex);
  }

  function languagePopoverStyle(): CSSProperties {
    return selectPopoverStyle(languagePopoverPlacement, selectedLanguageIndex);
  }

  return (
    <div className="settings-page" data-controlled={controlled || undefined}>
      {controlled ? null : (
        <>
          <header className="settings-header">
            <h1 className="settings-title">Settings</h1>
            <p className="settings-description">
              Manage audio, dictation, AI models, and agent capabilities.
            </p>
          </header>

          <nav className="settings-nav" role="tablist" aria-label="Settings sections">
            {settingsTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`settings-panel-${tab.id}`}
                id={`settings-tab-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </>
      )}

      <div
        className="settings-tab-panel"
        role="tabpanel"
        id={`settings-panel-${activeTab}`}
        aria-labelledby={`settings-tab-${activeTab}`}
      >
        {activeTab === "general" ? (
          <>
            <AccountSettingsSection
              account={account}
              loading={accountLoading}
              onAccountChanged={onAccountChanged}
              onRefresh={onAccountRefresh}
            />

            <section className="settings-group" aria-labelledby="appearance-heading">
              <h2 id="appearance-heading" className="settings-group-heading">
                Appearance
              </h2>
              <div className="settings-card">
                <div className="settings-rows">
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <h3 className="settings-row-title">Theme</h3>
                      <p className="settings-row-description">
                        Match the system or force light or dark mode.
                      </p>
                    </div>
                    <div className="settings-row-control">
                      <SegmentedControl<ThemePreference>
                        aria-label="App theme"
                        value={theme}
                        options={THEME_OPTIONS}
                        onValueChange={(next) => {
                          setTheme(next);
                          setStoredTheme(next);
                        }}
                      />
                    </div>
                  </div>
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <h3 className="settings-row-title">Accent</h3>
                      <p className="settings-row-description">
                        The brand color used across buttons, highlights, and the recorder.
                      </p>
                    </div>
                    <div className="settings-row-control">
                      {brand !== DEFAULT_BRAND ? (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          aria-label="Reset accent color to default"
                          onClick={() => {
                            setBrand(DEFAULT_BRAND);
                            setStoredBrand(DEFAULT_BRAND);
                          }}
                        >
                          Reset
                        </button>
                      ) : null}
                      <AccentWheel
                        value={brand}
                        onChange={(id) => {
                          setBrand(id);
                          setStoredBrand(id);
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <PermissionsSettingsSection
              microphonePermissionStatus={microphonePermissionStatus}
              microphoneReadiness={microphoneReadiness}
              accessibilityPermissionStatus={accessibilityPermissionStatus}
              systemReadiness={systemReadiness}
              onEnableMicrophone={onEnableMicrophone}
              onEnableAccessibility={onEnableAccessibility}
              onEnableSystemAudio={onEnableSystemAudio}
            />
          </>
        ) : null}

        {activeTab === "billing" && !account.localDev ? (
          <BillingSettingsSection account={account} onRefresh={onAccountRefresh} />
        ) : null}

        {activeTab === "shortcuts" ? (
          <section className="settings-group" aria-labelledby="shortcuts-heading">
            <h2 id="shortcuts-heading" className="settings-group-heading">
              Shortcuts
            </h2>
            <div className="settings-card">
              <div className="settings-rows">
                {macLikePlatform ? (
                  <>
                    <ShortcutRow
                      title="Push to talk"
                      description="Hold this shortcut to dictate, then release to paste."
                      shortcut={settings.pushToTalkShortcut}
                      defaultShortcut={DEFAULT_SHORTCUTS.push_to_talk}
                      capturing={capturingShortcut === "push_to_talk"}
                      disabled={!!capturingShortcut && capturingShortcut !== "push_to_talk"}
                      error={capturingShortcut === "push_to_talk" ? shortcutError : undefined}
                      onChange={() => void startShortcutCapture("push_to_talk")}
                      onReset={() =>
                        void saveShortcut("push_to_talk", DEFAULT_SHORTCUTS.push_to_talk)
                      }
                      onCancel={() => void cancelShortcutCapture()}
                    />

                    <ShortcutRow
                      title="Toggle dictation"
                      description="Press this shortcut to start or stop dictation."
                      shortcut={settings.toggleShortcut}
                      defaultShortcut={DEFAULT_SHORTCUTS.toggle}
                      capturing={capturingShortcut === "toggle"}
                      disabled={!!capturingShortcut && capturingShortcut !== "toggle"}
                      error={capturingShortcut === "toggle" ? shortcutError : undefined}
                      onChange={() => void startShortcutCapture("toggle")}
                      onReset={() => void saveShortcut("toggle", DEFAULT_SHORTCUTS.toggle)}
                      onCancel={() => void cancelShortcutCapture()}
                    />
                  </>
                ) : (
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <h3 className="settings-row-title">Dictation shortcuts unavailable</h3>
                      <p className="settings-row-description">
                        Global dictation shortcuts are only supported on macOS.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === "dictation" ? (
          <>
            <section className="settings-group" aria-labelledby="dictation-heading">
              <h2 id="dictation-heading" className="settings-group-heading">
                Dictation
              </h2>
              <div className="settings-card">
                <div className="settings-rows">
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <h3 className="settings-row-title">Language</h3>
                      <p className="settings-row-description">
                        Default language hint for note transcription and dictation.
                      </p>
                    </div>
                    <div className="settings-row-control" ref={languageWrapRef}>
                      <button
                        type="button"
                        className="select-trigger settings-language-select"
                        aria-label="Default transcription language"
                        aria-haspopup="listbox"
                        aria-expanded={languageOpen}
                        onClick={() => setLanguageOpen((value) => !value)}
                      >
                        <span>{languageLabel(settings.language ?? "")}</span>
                        <IconChevronDownSmall size={14} />
                      </button>
                      {languageOpen ? (
                        <ul
                          className="select-popover"
                          role="listbox"
                          data-placement={languagePopoverPlacement}
                          style={languagePopoverStyle()}
                        >
                          {LANGUAGE_OPTIONS.map((option) => {
                            const selected = option.value === (settings.language ?? "");
                            return (
                              <li key={option.value || "auto"}>
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={selected}
                                  data-selected={selected}
                                  onClick={() => void selectLanguage(option.value)}
                                >
                                  <span>{option.label}</span>
                                  <span className="select-check" aria-hidden>
                                    {selected ? <IconCheckmark1Small size={14} /> : null}
                                  </span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <StyleSettingsSection />

            <DictionarySettingsSection />
          </>
        ) : null}

        {activeTab === "audio" ? (
          <section className="settings-group" aria-labelledby="audio-heading">
            <h2 id="audio-heading" className="settings-group-heading">
              Audio
            </h2>
            <div className="settings-card">
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-info">
                    <h3 className="settings-row-title">Microphone</h3>
                    <p className="settings-row-description">{microphoneDescription}</p>
                  </div>
                  <div className="settings-row-control" ref={micWrapRef}>
                    <button
                      type="button"
                      className="select-trigger"
                      aria-haspopup="listbox"
                      aria-expanded={micOpen}
                      onClick={() => {
                        setMicOpen((value) => !value);
                        void requestMicrophones();
                      }}
                    >
                      <span>{microphoneName}</span>
                      <IconChevronDownSmall size={14} />
                    </button>
                    {micOpen ? (
                      // 2px = (trigger 32 - item 28) / 2, so the selected item
                      // overlays the trigger label exactly with no visual jump.
                      <ul
                        className="select-popover"
                        role="listbox"
                        data-placement={micPopoverPlacement}
                        style={microphonePopoverStyle()}
                      >
                        {microphoneOptions.map((option) => {
                          const selected = (option.id ?? "") === (settings.microphone.id ?? "");
                          return (
                            <li key={option.id ?? "auto"}>
                              <button
                                type="button"
                                role="option"
                                aria-selected={selected}
                                data-selected={selected}
                                onClick={() =>
                                  void selectMicrophone(
                                    option.id,
                                    option.id ? option.name : undefined,
                                  )
                                }
                              >
                                <span>{option.name}</span>
                                <span className="select-check" aria-hidden>
                                  {selected ? <IconCheckmark1Small size={14} /> : null}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                </div>

                {macLikePlatform ? (
                  <MicTestControl
                    state={micTestState}
                    level={micTestLevel}
                    elapsedMs={micTestElapsedMs}
                    sampleSrc={micTestSampleSrc}
                    error={micTestError}
                    playing={micTestPlaying}
                    durationSeconds={MIC_TEST_DURATION_SECONDS}
                    onStart={() => void startMicTest()}
                    onStartOver={() => void startOverMicTest()}
                    onPlaybackError={() => {
                      setMicTestError("Microphone test recorded, but playback is unavailable.");
                    }}
                    onPlayingChange={setMicTestPlaying}
                  />
                ) : null}

                {systemUnavailable ? null : (
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <h3 className="settings-row-title">System audio</h3>
                      <p className="settings-row-description">
                        Capture audio from other apps along with your microphone.
                      </p>
                    </div>
                    <div className="settings-row-control">
                      {systemDenied ? (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={onEnableSystemAudio}
                        >
                          Enable
                        </button>
                      ) : null}
                      <Switch
                        checked={systemOn}
                        disabled={checkingSourceReadiness || systemDenied}
                        aria-label="Capture system audio for notes"
                        onCheckedChange={(next) =>
                          onSourceModeChange(next ? "microphonePlusSystem" : "microphoneOnly")
                        }
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === "models" ? (
          <>
            <ModelPickerDialog
              open={!!pickerMode}
              mode={pickerMode ?? "transcription"}
              value={pickerValue}
              options={pickerOptions}
              search={modelSearch}
              onSearchChange={setModelSearch}
              onClose={() => setPickerMode(undefined)}
              onSelect={(modelId) => {
                if (!pickerMode) return;
                void selectVeniceModel(pickerMode, modelId);
                setPickerMode(undefined);
              }}
            />

            <section className="settings-group" aria-labelledby="models-heading">
              <h2 id="models-heading" className="settings-group-heading">
                AI models
              </h2>
              <div className="settings-card">
                <div className="settings-rows">
                  <ModelRow
                    title="Transcription"
                    description="Speech-to-text for note recordings and dictation."
                    value={providerSettings.transcriptionModel}
                    options={transcriptionOptions}
                    onOpen={() => openModelPicker("transcription")}
                  />
                  <ModelRow
                    title="Text"
                    description="Used for generated notes and agent responses."
                    value={providerSettings.generationModel}
                    options={generationOptions}
                    onOpen={() => openModelPicker("generation")}
                  />
                  <button
                    type="button"
                    className="settings-row settings-more-options-trigger"
                    aria-expanded={showMoreModelOptions}
                    aria-controls="models-more-options"
                    onClick={() => setShowMoreModelOptions((open) => !open)}
                  >
                    <span className="settings-row-info">
                      <span className="settings-row-title">More options</span>
                      <span className="settings-row-description">Advanced model settings.</span>
                    </span>
                    <IconChevronDownSmall
                      className="settings-more-options-chevron"
                      size={14}
                      aria-hidden
                    />
                  </button>
                  {showMoreModelOptions ? (
                    <VeniceApiKeyRow
                      id="models-more-options"
                      configured={providerSettings.veniceApiKeyConfigured}
                      value={veniceApiKeyDraft}
                      onValueChange={setVeniceApiKeyDraft}
                      onSave={() => void saveVeniceApiKey()}
                      onRemove={() => void removeVeniceApiKey()}
                    />
                  ) : null}
                </div>
              </div>
            </section>

            {IMAGE_GENERATION_ENABLED ? (
              <section className="settings-group" aria-labelledby="image-generation-heading">
                <h2 id="image-generation-heading" className="settings-group-heading">
                  Image generation
                </h2>
                <p className="settings-group-description">
                  Choose the model June uses when you ask it to generate an image.
                </p>
                <div className="settings-card">
                  <div className="settings-rows">
                    <ModelRow
                      title="Image"
                      description="Used when you generate an image from chat."
                      value={providerSettings.imageModel}
                      options={imageOptions}
                      onOpen={() => openModelPicker("image")}
                    />
                  </div>
                </div>
              </section>
            ) : null}
          </>
        ) : null}

        {activeTab === "agent" ? <AgentSettingsSection /> : null}

        {activeTab === "skills" ? <InstalledSkillsSection /> : null}
        {activeTab === "external-dirs" ? <ExternalDirsSection /> : null}
        {activeTab === "skill-review" ? <SkillReviewSection /> : null}

        {activeTab === "mcp" ? <McpServersSection /> : null}
        {activeTab === "mcp-catalog" ? <McpCatalogSection /> : null}
        {activeTab === "mcp-diagnostics" ? <McpDiagnosticsSection /> : null}
        {activeTab === "mcp-security" ? <McpSecuritySection /> : null}
        {activeTab === "skills-hub" ? <SkillsHubSection /> : null}
        {activeTab === "taps" ? (
          <TeamTapsSection onConfigureGithubToken={() => setActiveTab("skills")} />
        ) : null}
        {activeTab === "toolsets" ? <ToolsetsSection /> : null}
        {activeTab === "bundles" ? <SkillBundlesSection onStartChat={onStartBundleChat} /> : null}
        {activeTab === "profile-builder" ? <ProfileBuilderSection /> : null}
        {activeTab === "integrations-health" ? (
          <IntegrationsHealthSection
            onNavigate={(target: IntegrationsHealthTarget) => setActiveTab(target)}
          />
        ) : null}
        {activeTab === "import-export" ? <SetupSnapshotSection /> : null}

        {activeTab === "about" ? (
          <section className="settings-group" aria-labelledby="about-heading">
            <h2 id="about-heading" className="settings-group-heading">
              About
            </h2>
            <div className="settings-card">
              <div className="settings-rows">
                <div className="settings-row settings-row-meta">
                  <div className="settings-row-info">
                    <h3 className="settings-row-title settings-meta-label">Release version</h3>
                  </div>
                  <div className="settings-row-control">
                    <span className="settings-meta-value">{APP_VERSION}</span>
                  </div>
                </div>

                <div className="settings-row settings-row-meta">
                  <div className="settings-row-info">
                    <h3 className="settings-row-title settings-meta-label">Commit</h3>
                  </div>
                  <div className="settings-row-control">
                    <span className="settings-meta-value settings-meta-value-mono">
                      {APP_COMMIT_HASH}
                    </span>
                  </div>
                </div>

                {onCheckForUpdates ? (
                  <>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <h3 className="settings-row-title">Updates</h3>
                        <p className="settings-row-description">
                          Check whether a newer version of June is available.
                        </p>
                      </div>
                      <div className="settings-row-control">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={onCheckForUpdates}
                        >
                          Check for updates
                        </button>
                      </div>
                    </div>

                    <div className="settings-row">
                      <div className="settings-row-info">
                        <h3 className="settings-row-title">Release channel</h3>
                        <p className="settings-row-description">
                          Stable is recommended. Release candidate gets early builds for testing.
                        </p>
                      </div>
                      <div className="settings-row-control">
                        <SegmentedControl<ReleaseChannel>
                          aria-label="Release channel"
                          value={releaseChannel}
                          options={RELEASE_CHANNEL_OPTIONS}
                          onValueChange={handleReleaseChannelChange}
                        />
                      </div>
                    </div>

                    {reconcileVersion ? (
                      <div className="settings-row">
                        <InlineNotice
                          aria-label="Switch to stable now"
                          eyebrow="Switch to stable now?"
                          body={`Installs ${reconcileVersion}, replacing your release candidate build. You'll get ${baseVersion()} when it reaches stable.`}
                          actions={
                            <>
                              <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => setReconcileVersion(undefined)}
                              >
                                Not now
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={confirmReconcileToStable}
                              >
                                Switch to stable
                              </button>
                            </>
                          }
                        />
                      </div>
                    ) : null}
                  </>
                ) : null}

                <div className="settings-row">
                  <div className="settings-row-info">
                    <h3 className="settings-row-title">Community</h3>
                    <p className="settings-row-description">
                      Join us in the June community on Telegram at{" "}
                      {JUNE_COMMUNITY_URL.replace("https://", "")}.
                    </p>
                  </div>
                  <div className="settings-row-control">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void juneOpenCommunityPage().catch(() => undefined)}
                    >
                      Join community
                    </button>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-row-info">
                    <h3 className="settings-row-title">Server verification</h3>
                    <p className="settings-row-description">
                      June&apos;s server runs in a confidential VM. See exactly what code is running
                      and how to verify it yourself.
                    </p>
                  </div>
                  <div className="settings-row-control">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void juneOpenVerifyPage().catch(() => undefined)}
                    >
                      Verify server
                    </button>
                  </div>
                </div>

                {onReportIssue ? (
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <h3 className="settings-row-title">Report an issue</h3>
                      <p className="settings-row-description">
                        Something not working? Describe it to June, attach a screenshot if you have
                        one, and June will send the report to the team along with its own diagnosis.
                      </p>
                    </div>
                    <div className="settings-row-control">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => onReportIssue("bug")}
                      >
                        Report an issue
                      </button>
                    </div>
                  </div>
                ) : null}

                {import.meta.env.DEV ? (
                  // Dev builds only: same helper the devtools console exposes
                  // as june.replayOnboarding() — clears completion and
                  // reloads into the wizard.
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <h3 className="settings-row-title">Replay onboarding</h3>
                      <p className="settings-row-description">
                        Dev only. Forget that onboarding finished and reload into the first-run
                        wizard.
                      </p>
                    </div>
                    <div className="settings-row-control">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => replayOnboarding()}
                      >
                        Replay onboarding
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

type PermissionStatusTone = "allowed" | "attention" | "blocked" | "unsupported" | "unknown";

type PermissionStatusView = {
  label: string;
  tone: PermissionStatusTone;
};

function PermissionsSettingsSection({
  microphonePermissionStatus,
  microphoneReadiness,
  accessibilityPermissionStatus,
  systemReadiness,
  onEnableMicrophone,
  onEnableAccessibility,
  onEnableSystemAudio,
}: {
  microphonePermissionStatus?: string;
  microphoneReadiness?: RecordingSourceReadinessDto["sources"][number];
  accessibilityPermissionStatus?: string;
  systemReadiness?: RecordingSourceReadinessDto["sources"][number];
  onEnableMicrophone?: () => void;
  onEnableAccessibility?: () => void;
  onEnableSystemAudio: () => void;
}) {
  const macLikePlatform = isMacLikePlatform();
  return (
    <section className="settings-group" aria-labelledby="permissions-heading">
      <h2 id="permissions-heading" className="settings-group-heading">
        System permissions
      </h2>
      <p className="settings-group-description">
        {macLikePlatform
          ? "macOS access used for recording audio, pasting dictation, and capturing system sound."
          : "Access used for recording audio."}
      </p>
      <div className="settings-card">
        <div className="settings-rows">
          <PermissionRow
            title="Microphone"
            description="Record dictation and note audio."
            status={permissionStatus(
              microphonePermissionStatus ?? microphoneReadiness?.permissionState,
            )}
            onManage={onEnableMicrophone}
          />

          {macLikePlatform ? (
            <>
              <PermissionRow
                title="Accessibility"
                description="Paste dictated text into the active app."
                status={permissionStatus(accessibilityPermissionStatus)}
                onManage={onEnableAccessibility}
              />

              <PermissionRow
                title="System audio"
                description="Record audio from other apps when system audio is enabled."
                status={sourcePermissionStatus(systemReadiness)}
                onManage={onEnableSystemAudio}
              />
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function PermissionRow({
  title,
  description,
  status,
  onManage,
}: {
  title: string;
  description: string;
  status: PermissionStatusView;
  onManage?: () => void;
}) {
  const actionDisabled = status.tone === "unsupported" || !onManage;
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <h3 className="settings-row-title">{title}</h3>
        <p className="settings-row-description">{description}</p>
      </div>
      <div className="settings-row-control settings-permission-control">
        <span
          className="settings-permission-status"
          data-status={status.tone}
          role="img"
          aria-label={status.label}
          title={status.label}
        >
          <PermissionStatusIcon tone={status.tone} />
        </span>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={actionDisabled}
          aria-label={`Manage ${title} permission`}
          onClick={onManage}
        >
          Manage
        </button>
      </div>
    </div>
  );
}

function PermissionStatusIcon({ tone }: { tone: PermissionStatusTone }) {
  if (tone === "allowed") return <IconCircleCheck size={16} />;
  if (tone === "unknown") return <IconCircleQuestionmark size={16} />;
  if (tone === "unsupported") return <IconCircleX size={16} />;
  return <IconExclamationCircle size={16} />;
}

function permissionStatus(state?: string): PermissionStatusView {
  switch (state) {
    case "granted":
      return { label: "Allowed", tone: "allowed" };
    case "denied":
      return { label: "Blocked", tone: "blocked" };
    case "restricted":
      return { label: "Restricted", tone: "blocked" };
    case "missing":
      return { label: "Needs access", tone: "attention" };
    case "not_determined":
      return { label: "Not requested", tone: "attention" };
    case "unsupported":
      return { label: "Unsupported", tone: "unsupported" };
    case "unknown":
      return { label: "Unknown", tone: "unknown" };
    default:
      return { label: "Checking", tone: "unknown" };
  }
}

function sourcePermissionStatus(
  source?: RecordingSourceReadinessDto["sources"][number],
): PermissionStatusView {
  if (!source) return { label: "Checking", tone: "unknown" };
  if (source.ready) return { label: "Allowed", tone: "allowed" };
  return permissionStatus(source.permissionState);
}

function stringPayload(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numericPayload(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed));
  }
  return 0;
}

function ModelRow({
  title,
  description,
  value,
  options,
  onOpen,
}: {
  title: string;
  description: string;
  value: string;
  options: VeniceModelDto[];
  onOpen: () => void;
}) {
  const model = selectedModel(options, value);
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <h3 className="settings-row-title">{title}</h3>
        <p className="settings-row-description">{description}</p>
      </div>
      <div className="settings-row-control settings-model-control">
        <button
          type="button"
          className="model-summary-button"
          onClick={onOpen}
          aria-label={`Change ${title.toLowerCase()} model`}
        >
          <span className="model-summary-logo" aria-hidden>
            <ProviderLogo provider={model.provider} id={model.id} name={model.name} />
          </span>
          <span className="model-summary-name">{model.name}</span>
          <IconChevronDownSmall size={14} />
          <span className="model-summary-meta">
            <ModelMeta model={model} />
          </span>
        </button>
      </div>
    </div>
  );
}

function VeniceApiKeyRow({
  id,
  configured,
  value,
  onValueChange,
  onSave,
  onRemove,
}: {
  id?: string;
  configured: boolean;
  value: string;
  onValueChange: (value: string) => void;
  onSave: () => void;
  onRemove: () => void;
}) {
  const canSave = value.trim().length > 0;
  return (
    <div id={id} className="settings-row settings-row-venice-key">
      <div className="settings-row-info">
        <h3 className="settings-row-title">Venice API key</h3>
        <p className="settings-row-description">
          Use your own key for Venice models so June credits are not used. Stored locally and sent
          only for Venice requests.
        </p>
        {configured ? (
          <p className="settings-row-description settings-row-substatus">Key saved.</p>
        ) : null}
      </div>
      <div className="settings-row-control settings-secret-control">
        <input
          className="settings-secret-input"
          type="password"
          value={value}
          autoComplete="off"
          spellCheck={false}
          placeholder={configured ? "Saved key hidden" : "Venice API key"}
          aria-label="Venice API key"
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canSave) onSave();
          }}
        />
        <button type="button" className="btn btn-secondary" disabled={!canSave} onClick={onSave}>
          Save
        </button>
        {configured ? (
          <button type="button" className="btn btn-secondary" onClick={onRemove}>
            Remove
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ShortcutRow({
  title,
  description,
  shortcut,
  defaultShortcut,
  capturing,
  disabled,
  error,
  onChange,
  onReset,
  onCancel,
}: {
  title: string;
  description: string;
  shortcut: DictationShortcutSetting;
  defaultShortcut: DictationShortcutSetting;
  capturing: boolean;
  disabled: boolean;
  error?: string;
  onChange: () => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const canReset = !capturing && !shortcutsMatch(shortcut, defaultShortcut) && !disabled;

  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <h3 className="settings-row-title">{title}</h3>
        <p className="settings-row-description">{description}</p>
        {error ? <p className="settings-row-error">{error}</p> : null}
      </div>
      <div className="settings-row-control">
        <KeycapShortcut label={shortcut.label} capturing={capturing} />
        <button
          type="button"
          className="btn btn-secondary"
          disabled={disabled}
          onClick={capturing ? onCancel : onChange}
        >
          {capturing ? "Cancel" : "Change"}
        </button>
        {canReset ? (
          <button
            type="button"
            className="btn btn-secondary"
            aria-label={`Reset ${title} shortcut to default`}
            onClick={onReset}
          >
            Reset
          </button>
        ) : null}
      </div>
    </div>
  );
}

function shortcutKindLabel(kind: DictationShortcutKind) {
  return kind === "toggle" ? "Toggle dictation" : "Push to talk";
}

function shortcutForKind(settings: DictationSettingsDto, kind: DictationShortcutKind) {
  return kind === "toggle" ? settings.toggleShortcut : settings.pushToTalkShortcut;
}

function shortcutsMatch(first: DictationShortcutSetting, second: DictationShortcutSetting) {
  const keyCodesMatch =
    first.keyCode === undefined || second.keyCode === undefined || first.keyCode === second.keyCode;

  return (
    keyCodesMatch &&
    first.code === second.code &&
    first.label === second.label &&
    first.pressCount === second.pressCount &&
    first.modifiers.command === second.modifiers.command &&
    first.modifiers.control === second.modifiers.control &&
    first.modifiers.option === second.modifiers.option &&
    first.modifiers.shift === second.modifiers.shift &&
    first.modifiers.function === second.modifiers.function
  );
}

function stringPayloadValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

// The running build is a release candidate (X.Y.Z-rc.N). Only these get the
// leave-rc reconcile offer; a clean stable build has nothing to reconcile.
function isPrereleaseBuild() {
  return APP_VERSION.includes("-rc");
}

// The base version an rc will become once promoted (0.0.25-rc.2 -> 0.0.25), used
// to reassure the user which stable they will land on when it ships.
function baseVersion() {
  return APP_VERSION.split("-")[0];
}
