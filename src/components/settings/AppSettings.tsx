import { listen } from "@tauri-apps/api/event";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCircleQuestionmark } from "central-icons/IconCircleQuestionmark";
import { IconCircleX } from "central-icons/IconCircleX";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconMoonStar } from "central-icons/IconMoonStar";
import { IconSun } from "central-icons/IconSun";
import { IconTelevision } from "central-icons/IconTelevision";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import {
  JUNE_COMMUNITY_URL,
  dictationHotkeyStatus,
  dictationHelperCommand,
  dictationSettings,
  listVeniceModels,
  localAudioFileSrc,
  providerModelSettings,
  juneOpenCommunityPage,
  juneOpenVerifyPage,
  clearVeniceApiKey,
  hermesBridgeStatus,
  saveLocalGenerationSettings,
  setLocalGenerationEnabled,
  probeLocalGenerationEndpoint,
  setDictationLanguage,
  setDictationMicrophone,
  setDictationShortcut,
  setImageSafeMode,
  setLiveTranscription,
  setCostQuality,
  setVeniceApiKey,
  setVeniceModel,
} from "../../lib/tauri";
import { LANGUAGE_OPTIONS, languageLabel } from "../../lib/dictation-languages";
import { autostartEnabled, autostartSupported, setAutostartEnabled } from "../../lib/autostart";
import { replayOnboarding } from "../../lib/onboarding";
import type {
  AccountStatus,
  DictationHelperEvent,
  DictationMicrophoneDeviceDto,
  DictationShortcutKind,
  DictationSettingsDto,
  DictationShortcutModifiers,
  DictationShortcutSetting,
  FolderDto,
  LocalGenerationSettingsDto,
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
  Select,
  selectPopoverPlacement,
  selectPopoverStyle,
  type SelectPopoverPlacement,
} from "../ui/Select";
import { SegmentedControl } from "../ui/SegmentedControl";
import { InlineNotice } from "../ui/InlineNotice";
import { Switch } from "../ui/Switch";
import { HoverTip } from "../ui/HoverTip";
import { APP_COMMIT_HASH, APP_VERSION } from "../../app/build-info";
import type { ReportCategory } from "../agent/composer/reportCategory";
import { getStoredTheme, setStoredTheme, type ThemePreference } from "../../lib/theme";
import { BRAND_PRESETS, getStoredBrand, setStoredBrand, type BrandId } from "../../lib/brand";
import {
  FONT_SCALE_PRESETS,
  setStoredFontScale,
  useFontScaleId,
  type FontScaleId,
} from "../../lib/font-scale";
import {
  getReleaseChannel,
  reconcileToStable,
  setReleaseChannel,
  type ReleaseChannel,
} from "../../lib/updater";
import {
  fallbackDictationCapabilities,
  isSystemAudioSupportedPlatform,
  useDictationCapabilities,
} from "../../lib/platform";
import { systemAudioAvailability } from "../../lib/source-readiness";
import { parseDictationHelperEvent } from "../../lib/dictation-events";
import {
  dispatchProviderModelSettingsChanged,
  modelAvailableForMode,
} from "../../lib/model-privacy";
import {
  isLoopbackUrl,
  localGenerationOptionId,
  withLocalGenerationOption,
} from "../../lib/local-generation";
import { ProviderLogo } from "./ProviderLogo";
import { AUTO_MODEL_ID, modelOptions, selectedModel } from "./ModelPickerDialog";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import {
  DEFAULT_GENERATION_SUGGESTION_ID,
  suggestedModelsForMode,
} from "../../lib/suggested-models";
import {
  AUTO_PREFERENCE_VALUES,
  autoPreferenceFromCostQuality,
  ModelPickerCardContent,
  ModelPickerPopover,
  type AutoPreference,
  type ModelPickerFlyout,
} from "./ModelPickerPopover";
import { DEFAULT_IMAGE_MODEL, imageModelCatalog } from "../../lib/image-models";
import { IMAGE_GENERATION_ENABLED, VIDEO_GENERATION_ENABLED } from "../../lib/feature-flags";
import { DEFAULT_VIDEO_MODEL, VIDEO_MODELS } from "../../lib/video-models";
import { AgentSettingsSection } from "./AgentSettingsSection";
import { ConnectorsSection } from "./ConnectorsSection";
import { ExternalDirsSection } from "./ExternalDirsSection";
import { InstalledSkillsSection } from "./InstalledSkillsSection";
import { SkillDetailSection } from "./SkillDetailSection";
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
import { MemorySettingsSection } from "./MemorySettingsSection";
import { MicTestControl, type MicTestState } from "./MicTestControl";
import { StyleSettingsSection } from "./StyleSettingsSection";
import { PrivacySettingsSection } from "./PrivacySettingsSection";
import { useActiveHermesProfileName } from "../../lib/active-hermes-profile";
import {
  DEFAULT_HERMES_PROFILE,
  adminTargetForMode,
  createHermesAdminClient,
  createRustAdminFetch,
} from "../../lib/hermes-admin";
import {
  getStoredDateFormat,
  setStoredDateFormat,
  type DateFormatPreference,
} from "../../lib/date-format";

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

const FONT_SCALE_OPTIONS: readonly {
  value: FontScaleId;
  label: ReactNode;
  ariaLabel: string;
}[] = FONT_SCALE_PRESETS.map((preset) => ({
  value: preset.id,
  label: preset.label,
  ariaLabel: `${preset.label} text size`,
}));

const DATE_FORMAT_OPTIONS = [
  { value: "system", label: "System" },
  { value: "month-first", label: "Jul 9" },
  { value: "day-first", label: "9 Jul" },
] satisfies { value: DateFormatPreference; label: string }[];

const RELEASE_CHANNEL_OPTIONS: readonly {
  value: ReleaseChannel;
  label: ReactNode;
}[] = [
  { value: "stable", label: "Stable" },
  { value: "rc", label: "Release candidate" },
];

const AUTO_PREFERENCE_OPTIONS: readonly {
  value: AutoPreference;
  label: ReactNode;
}[] = [
  { value: "cost", label: "Lower cost" },
  { value: "balanced", label: "Balanced" },
  { value: "quality", label: "Higher quality" },
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

const WINDOWS_DEFAULT_SHORTCUTS: Record<DictationShortcutKind, DictationShortcutSetting> = {
  push_to_talk: {
    ...DEFAULT_SETTINGS.pushToTalkShortcut,
    label: "Ctrl+Alt+D",
  },
  toggle: {
    ...DEFAULT_SETTINGS.toggleShortcut,
    label: "Ctrl+Alt+T",
  },
};

const DEFAULT_PROVIDER_MODELS: ProviderModelSettingsDto = {
  transcriptionProvider: "venice",
  generationProvider: "venice",
  transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
  // Mirrors DEFAULT_GENERATION_MODEL in the Rust providers module and the
  // leading Suggested pick in lib/suggested-models.ts.
  generationModel: "zai-org-glm-5-2",
  // Mirrors DEFAULT_COST_QUALITY in the Rust providers module.
  costQuality: 100,
  remoteGenerationModel: "zai-org-glm-5-2",
  // Mirrors DEFAULT_IMAGE_MODEL in the Rust providers module.
  imageModel: DEFAULT_IMAGE_MODEL,
  // Mirrors DEFAULT_VIDEO_MODEL in the Rust providers module.
  videoModel: DEFAULT_VIDEO_MODEL,
  veniceApiKeyConfigured: false,
  localGeneration: {
    baseUrl: "",
    modelId: "",
    apiKey: "",
  },
  // On by default, matching the Rust providers default.
  imageSafeMode: true,
  imageSafeModePromptDismissed: false,
  liveTranscription: true,
};

type ProviderModelSettingsSnapshot = {
  settings: ProviderModelSettingsDto;
  effectiveSettings?: ProviderModelSettingsDto;
};

function mergeProviderModelSettings(settings?: Partial<ProviderModelSettingsDto>) {
  return {
    ...DEFAULT_PROVIDER_MODELS,
    ...settings,
  };
}

function providerModelSettingsSnapshot(response: ProviderModelSettingsSnapshot) {
  const settings = mergeProviderModelSettings(response.settings);
  return {
    settings,
    effectiveSettings: mergeProviderModelSettings(response.effectiveSettings ?? response.settings),
  };
}

async function activeProfileTextModel(profileName: string): Promise<string | undefined> {
  const status = await hermesBridgeStatus();
  const target =
    adminTargetForMode(status, "sandboxed", profileName) ??
    adminTargetForMode(status, "unrestricted", profileName);
  if (!target) return undefined;
  const client = createHermesAdminClient(target, {
    fetch: createRustAdminFetch(target.mode),
  });
  const profiles = await client.profiles.list();
  const normalized = profileName.trim().toLowerCase();
  return profiles
    .find((profile) => profile.name.trim().toLowerCase() === normalized)
    ?.model?.trim();
}

const MIC_TEST_DURATION_SECONDS = 5;

export type SettingsTab =
  | "general"
  | "appearance"
  | "billing"
  | "shortcuts"
  | "dictation"
  | "audio"
  | "models"
  | "agent"
  | "memory"
  | "connectors"
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
  { id: "appearance", label: "Appearance" },
  { id: "billing", label: "Billing" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "dictation", label: "Dictation" },
  { id: "audio", label: "Audio" },
  { id: "models", label: "Models" },
  { id: "agent", label: "Agent" },
  { id: "memory", label: "Memory" },
  { id: "connectors", label: "Plugins" },
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
  { id: "profile-builder", label: "Profiles" },
  { id: "integrations-health", label: "Integrations health" },
  { id: "import-export", label: "Import / export" },
  { id: "about", label: "About" },
];

/**
 * The shared settings page header (Codex-app style): a large serif page title
 * with one muted one-line blurb beneath, and generous space before the content.
 * Every settings panel opens with this so the page announces what it is; panels
 * with multiple sub-groups keep their small `.settings-group-heading` labels
 * below it.
 */
export function SettingsPageHeader({
  id,
  title,
  blurb,
}: {
  /** Ties the panel's `aria-labelledby` to the visible page title. */
  id?: string;
  title: ReactNode;
  blurb?: ReactNode;
}) {
  return (
    <header className="settings-page-header">
      <h2 id={id} className="settings-page-title">
        {title}
      </h2>
      {blurb ? <p className="settings-page-blurb">{blurb}</p> : null}
    </header>
  );
}

type AppSettingsProps = {
  folders?: FolderDto[];
  onFoldersImported?: (folders: FolderDto[]) => void;
  /** When Memory is opened from a project, the manager pre-filters to it. */
  memoryFolderFilter?: string;
  /** Drill from a memory's project tag into that project. */
  onOpenProject?: (folderId: string) => void;
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
  // Reports when a drill-in detail (skill detail) is open so the host can hand
  // this view the scroll container, notes-style: the shell sets
  // data-note-detail-scroller on .main-panel-body and the detail owns its own
  // scroll region under a pinned breadcrumb bar.
  onDetailPinnedChange?: (pinned: boolean) => void;
  // Runs the app updater's manual check flow.
  onCheckForUpdates?: () => void;
  // True when an update is downloaded and waiting for a relaunch. The bundle
  // swap is what can kill the dictation helper, so the "dictation paused"
  // notice points the user at the relaunch that finishes the update.
  updateReadyToRelaunch?: boolean;
  // Relaunches June to finish a staged update (also restores the helper).
  onRelaunch?: () => void;
  // Confirmed leave-rc reconcile: downloads and installs the current stable,
  // even if it is older than the running prerelease build (Q4-Q8).
  onReconcileToStable?: () => void;
  // Opens Agent with the direct issue report dialog preselected.
  onReportIssue?: (category: ReportCategory) => void;
  // Opens a new agent session that runs a skill bundle's slash command.
  onStartBundleChat?: (prompt: string) => void;
};

export function AppSettings({
  folders = [],
  onFoldersImported,
  memoryFolderFilter,
  onOpenProject,
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
  onDetailPinnedChange,
  onCheckForUpdates,
  updateReadyToRelaunch,
  onRelaunch,
  onReconcileToStable,
  onReportIssue,
  onStartBundleChat,
}: AppSettingsProps) {
  const [settings, setSettings] = useState<DictationSettingsDto>(DEFAULT_SETTINGS);
  const [providerSettings, setProviderSettings] =
    useState<ProviderModelSettingsDto>(DEFAULT_PROVIDER_MODELS);
  const [effectiveProviderSettings, setEffectiveProviderSettings] =
    useState<ProviderModelSettingsDto>(DEFAULT_PROVIDER_MODELS);
  const providerSettingsProfileRef = useRef<string | null>(null);
  const [localGenerationDraft, setLocalGenerationDraft] = useState<LocalGenerationSettingsDto>(
    DEFAULT_PROVIDER_MODELS.localGeneration,
  );
  const activeProfileName = useActiveHermesProfileName();
  const showingActiveProfileModels = activeProfileName !== DEFAULT_HERMES_PROFILE;
  const [activeProfileGenerationModel, setActiveProfileGenerationModel] = useState<string>();
  // Model ids returned by the last successful "Test connection" probe, used to
  // populate the Model ID field's datalist (free text is still allowed).
  const [localProbeModels, setLocalProbeModels] = useState<string[]>([]);
  // A non-loopback endpoint requires an explicit confirm before enabling, so
  // the switch doesn't silently start sending prompts off the device. Set when
  // the switch is flipped for a remote endpoint; the confirm affordance
  // proceeds.
  const [localEnableConfirm, setLocalEnableConfirm] = useState(false);
  const [veniceModels, setVeniceModels] = useState<Record<ProviderModelMode, VeniceModelDto[]>>({
    transcription: [],
    generation: [],
    // Image options come from a curated local list, not the fetched catalog;
    // this stays empty and `imageOptions` supplies the picker. Video follows
    // the same curated-local pattern while the first fast path is fixed-shape.
    image: [],
    video: [],
  });
  const [microphones, setMicrophones] = useState<DictationMicrophoneDeviceDto[]>([]);
  const [defaultMicrophone, setDefaultMicrophone] = useState<DictationMicrophoneDeviceDto>();
  const [capturingShortcut, setCapturingShortcut] = useState<DictationShortcutKind>();
  const capturingShortcutRef = useRef<DictationShortcutKind>();
  const [shortcutError, setShortcutError] = useState<string>();
  const [shortcutErrorKind, setShortcutErrorKind] = useState<DictationShortcutKind>();
  const [status, setStatus] = useState<string>();
  // Set when the dictation helper dies (crash or the bundle swap after an
  // update) and cleared once it re-arms the hotkey, so the shortcuts pane never
  // silently shows a dead hotkey.
  const [helperUnavailable, setHelperUnavailable] = useState<{
    reason: string;
    message: string;
  }>();
  const [micOpen, setMicOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(() => getStoredTheme());
  const [brand, setBrand] = useState<BrandId>(() => getStoredBrand());
  const fontScale = useFontScaleId();
  const [dateFormat, setDateFormat] = useState<DateFormatPreference>(() => getStoredDateFormat());
  const [releaseChannel, setReleaseChannelValue] = useState<ReleaseChannel>("stable");
  // Set only when a leave-rc switch turns up an installable stable, so the
  // bespoke in-context confirm below the toggle can name the exact version.
  const [reconcileVersion, setReconcileVersion] = useState<string>();
  const [pickerMode, setPickerMode] = useState<ProviderModelMode>();
  const [modelPickerFlyout, setModelPickerFlyout] = useState<ModelPickerFlyout>(null);
  const [modelSearch, setModelSearch] = useState("");
  const modelPickerTriggerRef = useRef<HTMLButtonElement>(null);
  const modelPickerPopoverRef = useRef<HTMLDivElement>(null);
  const modelPickerSearchRef = useRef<HTMLInputElement>(null);
  const costQualitySaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const latestCostQualitySaveRef = useRef(0);
  const confirmedCostQualityRef = useRef(DEFAULT_PROVIDER_MODELS.costQuality);
  const [veniceApiKeyDraft, setVeniceApiKeyDraft] = useState("");
  // Saving a Venice key while Auto is the text model would silently keep
  // billing June credits (Auto never uses the key), so the save surfaces an
  // explicit billing choice: switch to a Venice model or knowingly keep Auto.
  const [veniceKeyAutoBillingChoiceOpen, setVeniceKeyAutoBillingChoiceOpen] = useState(false);
  const [showMoreModelOptions, setShowMoreModelOptions] = useState(false);
  const [showMoreImageOptions, setShowMoreImageOptions] = useState(false);
  const [localModelSetupVisible, setLocalModelSetupVisible] = useState(false);
  const [localModelStatus, setLocalModelStatus] = useState<string>();
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
  // The skill opened from Installed skills. While set (and the skills tab is
  // active) the whole settings page swaps for the notes-style detail shell:
  // pinned breadcrumb bar on top, its own scroll region beneath.
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const skillDetailOpen = activeTab === "skills" && openSkill !== null;
  // The agent tab's messaging platform drill-in pins the SAME notes-style detail
  // shell as skill detail, and lifts its selection here (mirroring `openSkill`)
  // so the detail can replace the whole settings page at the top level rather
  // than render nested — that top-level placement is what pins the breadcrumb
  // bar. Placement is decided synchronously from this id, so there's no effect
  // lag. Both signals feed the same host hook so only one reaches App.tsx.
  const [agentPlatformId, setAgentPlatformId] = useState<string>();
  const agentDetailOpen = activeTab === "agent" && agentPlatformId != null;
  const detailPinned = skillDetailOpen || agentDetailOpen;
  useEffect(() => {
    onDetailPinnedChange?.(detailPinned);
  }, [detailPinned, onDetailPinnedChange]);
  // Never leave the host thinking a detail scroller is active after unmount.
  useEffect(() => () => onDetailPinnedChange?.(false), [onDetailPinnedChange]);
  const settingsTabs = account.localDev
    ? SETTINGS_TABS.filter((tab) => tab.id !== "billing")
    : SETTINGS_TABS;
  const capabilities = useDictationCapabilities();
  const macLikePlatform = capabilities.platform === "macos";
  const systemAudioSupportedPlatform = capabilities.systemAudio || isSystemAudioSupportedPlatform();
  const defaultShortcuts =
    capabilities.platform === "windows"
      ? WINDOWS_DEFAULT_SHORTCUTS
      : {
          push_to_talk: DEFAULT_SETTINGS.pushToTalkShortcut,
          toggle: DEFAULT_SETTINGS.toggleShortcut,
        };
  const modifierRequiredMessage =
    capabilities.platform === "windows"
      ? "Shortcut must include Ctrl, Alt, Shift, or Win."
      : MODIFIER_REQUIRED_MESSAGE;
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
  const systemAvailability = systemAudioAvailability(sourceReadiness);
  // Denied and granted-but-uncapturable both lock the switch, but only a real
  // denial is fixable in System Settings: the uncapturable helper recovers on
  // restart, so sending the user to grant an already-granted permission would
  // be a dead end. The status label tells the two apart.
  const systemDenied = systemAvailability === "denied";
  const systemLocked = systemDenied || systemAvailability === "unavailable";
  const systemUnavailable = !systemAudioSupportedPlatform || systemAvailability === "unsupported";

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
    setLocalGenerationDraft(providerSettings.localGeneration);
  }, [
    providerSettings.localGeneration.baseUrl,
    providerSettings.localGeneration.modelId,
    providerSettings.localGeneration.apiKey,
  ]);

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
        const hotkeyStatus = await dictationHotkeyStatus();
        if (cancelled) return;
        handleHelperEvent(hotkeyStatus);
        const modelResponse = await providerModelSettings();
        if (cancelled) return;
        // Merge over defaults so a settings payload that predates a field
        // (e.g. imageModel from an older backend) still has every model set.
        const modelSnapshot = providerModelSettingsSnapshot(modelResponse);
        confirmedCostQualityRef.current = modelSnapshot.settings.costQuality;
        setProviderSettings(modelSnapshot.settings);
        setEffectiveProviderSettings(modelSnapshot.effectiveSettings);
        providerSettingsProfileRef.current = activeProfileName;
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
    if (
      providerSettingsProfileRef.current === null ||
      providerSettingsProfileRef.current === activeProfileName
    ) {
      return;
    }
    let cancelled = false;

    async function refreshProviderModelsForProfile() {
      try {
        const modelResponse = await providerModelSettings();
        if (cancelled) return;
        const modelSnapshot = providerModelSettingsSnapshot(modelResponse);
        setProviderSettings(modelSnapshot.settings);
        setEffectiveProviderSettings(modelSnapshot.effectiveSettings);
        providerSettingsProfileRef.current = activeProfileName;
      } catch (error) {
        if (!cancelled) setStatus(messageFromError(error));
      }
    }

    void refreshProviderModelsForProfile();
    return () => {
      cancelled = true;
    };
  }, [activeProfileName]);

  useEffect(() => {
    if (!showingActiveProfileModels) {
      setActiveProfileGenerationModel(undefined);
      return;
    }
    let cancelled = false;
    setActiveProfileGenerationModel(undefined);

    async function loadActiveProfileTextModel() {
      try {
        const model = await activeProfileTextModel(activeProfileName);
        if (!cancelled) setActiveProfileGenerationModel(model);
      } catch {
        if (!cancelled) setActiveProfileGenerationModel(undefined);
      }
    }

    void loadActiveProfileTextModel();
    return () => {
      cancelled = true;
    };
  }, [activeProfileName, showingActiveProfileModels]);

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
        setShortcutError(modifierRequiredMessage);
        setShortcutErrorKind(kind);
        setStatus(modifierRequiredMessage);
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
    if (helperEvent.type === "helper_unavailable") {
      setHelperUnavailable({
        reason: stringPayload(helperEvent.payload?.reason) ?? "restarting",
        message: helperEvent.payload?.message ?? "Dictation stopped and is restarting.",
      });
      return;
    }
    if (helperEvent.type === "hotkey_trigger_ready") {
      // The helper re-armed the hotkey, so it is back: clear any down notice.
      setHelperUnavailable(undefined);
      return;
    }
    if (helperEvent.type === "hotkey_trigger_unavailable") {
      const message = helperEvent.payload?.message ?? "Dictation shortcut is unavailable.";
      const kind = shortcutKindPayload(helperEvent.payload?.kind);
      setHelperUnavailable(undefined);
      setShortcutError(message);
      setShortcutErrorKind(kind);
      setStatus(message);
      return;
    }
    if (helperEvent.type === "shortcut_capture_started") {
      setStatus("Press the shortcut to record it.");
      return;
    }
    if (helperEvent.type === "shortcut_capture_error") {
      const message = helperEvent.payload?.message ?? "Shortcut could not be captured.";
      const kind = shortcutKindPayload(helperEvent.payload?.kind) ?? capturingShortcutRef.current;
      setCapturingShortcut(undefined);
      setShortcutError(message);
      setShortcutErrorKind(kind);
      setStatus(message);
      return;
    }
    if (helperEvent.type === "shortcut_capture_cancelled") {
      setCapturingShortcut(undefined);
      setShortcutError(undefined);
      setShortcutErrorKind(undefined);
      setStatus("Shortcut capture ended.");
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
      setShortcutErrorKind(undefined);
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
      setShortcutError(undefined);
      setShortcutErrorKind(undefined);
      setStatus(`${shortcutKindLabel(kind)} set to ${shortcutForKind(next, kind).label}.`);
    } catch (error) {
      setShortcutError(messageFromError(error));
      setShortcutErrorKind(kind);
      setStatus(messageFromError(error));
    }
  }

  async function startShortcutCapture(kind: DictationShortcutKind) {
    setShortcutError(undefined);
    setShortcutErrorKind(undefined);
    setCapturingShortcut(kind);
    try {
      await dictationHelperCommand({
        type: "start_shortcut_capture",
        kind,
        pressCount: 1,
      });
    } catch (error) {
      setCapturingShortcut(undefined);
      setShortcutError(messageFromError(error));
      setShortcutErrorKind(kind);
      setStatus(messageFromError(error));
    }
  }

  async function cancelShortcutCapture() {
    setCapturingShortcut(undefined);
    setShortcutError(undefined);
    setShortcutErrorKind(undefined);
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

  // Returns whether the switch persisted, so confirmation flows (the Venice
  // key billing choice) can stay open instead of closing over a failed save.
  async function selectVeniceModel(mode: ProviderModelMode, modelId: string): Promise<boolean> {
    if (showingActiveProfileModels) return false;
    try {
      const next = await setVeniceModel(mode, modelId);
      setProviderSettings(next);
      setEffectiveProviderSettings(next);
      dispatchProviderModelSettingsChanged({ mode, modelId });
      setStatus(
        mode === "transcription"
          ? "Transcription model updated."
          : mode === "image"
            ? "Image model updated."
            : mode === "video"
              ? "Video model updated."
              : "Text model updated.",
      );
      return true;
    } catch (error) {
      setStatus(messageFromError(error));
      return false;
    }
  }

  function saveCostQuality(value: number) {
    const version = ++latestCostQualitySaveRef.current;
    const save = costQualitySaveChainRef.current.then(() => setCostQuality(value));
    costQualitySaveChainRef.current = save.then(
      () => undefined,
      () => undefined,
    );
    void save.then(
      (next) => {
        confirmedCostQualityRef.current = next.costQuality;
        if (version !== latestCostQualitySaveRef.current) return;
        setProviderSettings((current) => ({
          ...current,
          costQuality: next.costQuality,
        }));
        setStatus("Automatic model preference updated.");
      },
      (error) => {
        if (version !== latestCostQualitySaveRef.current) return;
        setProviderSettings((current) => ({
          ...current,
          costQuality: confirmedCostQualityRef.current,
        }));
        setStatus(messageFromError(error));
      },
    );
  }

  function closeModelPicker() {
    setPickerMode(undefined);
    setModelPickerFlyout(null);
    setModelSearch("");
  }

  // Optimistic apply + persisted save, shared by the Models row's segmented
  // control and the model picker popover's Auto section.
  function applyCostQuality(costQuality: number) {
    setProviderSettings((current) => ({ ...current, costQuality }));
    saveCostQuality(costQuality);
  }

  function selectModelFromPicker(
    mode: ProviderModelMode,
    modelId: string,
    costQuality?: number,
    options?: { keepOpen?: boolean },
  ) {
    // Named profiles show their own models read-only; a pick is a no-op.
    if (showingActiveProfileModels) {
      closeModelPicker();
      return;
    }
    const picked = modelOptionsForMode(mode).find((model) => model.id === modelId);
    if (mode === "generation" && costQuality !== undefined) {
      applyCostQuality(costQuality);
    }
    if (mode === "generation" && picked?.provider === "local") {
      enableLocalGenerationFromPicker();
    } else {
      void selectVeniceModel(mode, modelId);
    }
    // The Auto toggle switches models mid-flow, so it asks to keep the picker
    // open; a row pick is a final choice and closes it.
    if (!options?.keepOpen) closeModelPicker();
  }

  // True when the draft matches what's persisted, so enabling can skip a
  // redundant save. The catalog is derived from providerSettings, never a
  // re-fetch, so there's no awaited network call to overwrite the status.
  function draftMatchesSavedLocal() {
    const saved = providerSettings.localGeneration;
    return (
      localGenerationDraft.baseUrl.trim() === saved.baseUrl.trim() &&
      localGenerationDraft.modelId.trim() === saved.modelId.trim() &&
      localGenerationDraft.apiKey === saved.apiKey
    );
  }

  // Persists the draft fields without changing the active provider. Returns
  // the updated settings on success (draft re-syncs from providerSettings via
  // effect); surfaces validation errors next to the local controls.
  async function commitLocalGenerationSettings() {
    try {
      const next = await saveLocalGenerationSettings({
        baseUrl: localGenerationDraft.baseUrl,
        modelId: localGenerationDraft.modelId,
        apiKey: localGenerationDraft.apiKey,
      });
      setProviderSettings(next);
      dispatchProviderModelSettingsChanged({
        mode: "generation",
        modelId: next.generationModel,
      });
      return next;
    } catch (error) {
      setLocalModelStatus(messageFromError(error));
      return undefined;
    }
  }

  async function handleSaveLocalModel() {
    const saved = await commitLocalGenerationSettings();
    if (saved) setLocalModelStatus("Local model saved.");
  }

  // Flips the provider to the saved local endpoint. The backend enables from
  // stored settings, so callers save any dirty draft first.
  async function commitLocalGenerationEnabled() {
    try {
      const next = await setLocalGenerationEnabled(true);
      setProviderSettings(next);
      dispatchProviderModelSettingsChanged({
        mode: "generation",
        modelId: next.generationModel,
      });
      setLocalEnableConfirm(false);
      setLocalModelSetupVisible(true);
      setLocalModelStatus("Local model enabled.");
    } catch (error) {
      setLocalModelStatus(messageFromError(error));
    }
  }

  // The model picker's local option enables from the SAVED settings (never
  // the draft), but it must honor the same off-device invariant as the
  // toggle: a non-loopback endpoint is never enabled silently. Instead of
  // enabling, it reveals the confirm affordance in More options
  // and says so; a loopback endpoint enables in one step.
  function enableLocalGenerationFromPicker() {
    const baseUrl = providerSettings.localGeneration.baseUrl.trim();
    if (!isLoopbackUrl(baseUrl)) {
      setLocalEnableConfirm(true);
      setLocalModelSetupVisible(true);
      // The confirm affordance lives behind More options; reveal it so the
      // status message's instruction is reachable.
      setShowMoreModelOptions(true);
      setLocalModelStatus(
        "This endpoint is not on this machine. Requests will leave your device. Confirm in More options to enable it.",
      );
      return;
    }
    void commitLocalGenerationEnabled();
  }

  async function enableLocalGeneration() {
    const baseUrl = localGenerationDraft.baseUrl.trim();
    const modelId = localGenerationDraft.modelId.trim();
    if (!baseUrl || !modelId) {
      setLocalModelSetupVisible(true);
      setLocalModelStatus("Enter a local endpoint and model ID first.");
      return;
    }
    // A remote endpoint takes a deliberate second step: the first flip reveals
    // the confirm affordance instead of enabling.
    if (!isLoopbackUrl(baseUrl) && !localEnableConfirm) {
      setLocalEnableConfirm(true);
      setLocalModelSetupVisible(true);
      return;
    }
    if (!draftMatchesSavedLocal()) {
      const saved = await commitLocalGenerationSettings();
      if (!saved) return;
    }
    await commitLocalGenerationEnabled();
  }

  async function disableLocalGeneration() {
    // Toggle-off never saves the draft: it only flips the provider back and
    // leaves the stored local fields untouched.
    setLocalEnableConfirm(false);
    try {
      const next = await setLocalGenerationEnabled(false);
      setProviderSettings(next);
      dispatchProviderModelSettingsChanged({
        mode: "generation",
        modelId: next.generationModel,
      });
      setLocalModelStatus("Local model disabled.");
    } catch (error) {
      setLocalModelStatus(messageFromError(error));
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
      // The workspace's model picker shows a billing note while a key is
      // saved, so let it refresh its provider settings snapshot.
      dispatchProviderModelSettingsChanged({ mode: "generation", modelId: next.generationModel });
      if (next.generationModel === AUTO_MODEL_ID) {
        setVeniceKeyAutoBillingChoiceOpen(true);
      }
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  function handleLocalToggle(enabled: boolean) {
    setLocalModelSetupVisible(true);
    if (enabled) {
      void enableLocalGeneration();
    } else {
      void disableLocalGeneration();
    }
  }

  async function testLocalConnection() {
    try {
      const result = await probeLocalGenerationEndpoint({
        baseUrl: localGenerationDraft.baseUrl,
        apiKey: localGenerationDraft.apiKey,
      });
      setLocalProbeModels(result.models);
      setLocalModelStatus(`Connected. ${result.models.length} models available.`);
    } catch (error) {
      setLocalModelStatus(messageFromError(error));
    }
  }

  async function removeVeniceApiKey() {
    try {
      const next = await clearVeniceApiKey();
      setProviderSettings(next);
      setVeniceApiKeyDraft("");
      setStatus("Venice API key removed.");
      dispatchProviderModelSettingsChanged({ mode: "generation", modelId: next.generationModel });
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function toggleLiveTranscription(enabled: boolean) {
    try {
      const next = await setLiveTranscription(enabled);
      setProviderSettings(next);
      setStatus(
        enabled
          ? "Live transcription on: the transcript streams while you record."
          : "Live transcription off: the transcript appears after the recording ends.",
      );
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function toggleImageSafeMode(enabled: boolean) {
    try {
      const next = await setImageSafeMode(enabled);
      setProviderSettings(next);
      setStatus(
        enabled
          ? "Safe mode on: adult content is blurred."
          : "Safe mode off: images are not filtered.",
      );
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
  const displayProviderSettings = showingActiveProfileModels
    ? effectiveProviderSettings
    : providerSettings;
  const transcriptionOptions = modelOptions(
    veniceModels.transcription,
    displayProviderSettings.transcriptionModel,
  );
  const localModelEnabled = providerSettings.generationProvider === "local";
  const generationCatalog = useMemo(
    () => withLocalGenerationOption(veniceModels.generation, providerSettings.localGeneration),
    [
      veniceModels.generation,
      providerSettings.localGeneration.baseUrl,
      providerSettings.localGeneration.modelId,
    ],
  );
  // Pass the prefixed local id (when local is enabled) so it matches the
  // catalog's local option. Passing the raw generationModel let modelOptions
  // prepend a bare duplicate entry that persisted the local id as the remote
  // model when clicked.
  const generationOptions = modelOptions(generationCatalog, modelValueForMode("generation"));
  // Where the billing-choice dialog lands when the user opts out of Auto to
  // use their Venice key: the leading suggested pick, else the first Venice
  // catalog model, drawn from the same selectable list as the model picker so
  // the dialog can never persist a model the picker would exclude (the factory
  // default stays the last resort for an empty catalog).
  const selectableGenerationOptions = generationOptions.filter((option) =>
    modelAvailableForMode("generation", option),
  );
  const veniceKeySwitchTarget =
    suggestedModelsForMode("generation", selectableGenerationOptions).find(
      (item) => item.model.id !== AUTO_MODEL_ID,
    )?.model ??
    selectableGenerationOptions.find(
      (option) => option.provider === "venice" && option.id !== AUTO_MODEL_ID,
    );
  const imageOptions = IMAGE_GENERATION_ENABLED
    ? modelOptions(imageModelCatalog(), displayProviderSettings.imageModel)
    : [];
  const videoOptions = VIDEO_GENERATION_ENABLED
    ? modelOptions(VIDEO_MODELS, displayProviderSettings.videoModel)
    : [];
  const localDraftBaseUrl = localGenerationDraft.baseUrl.trim();
  const localNonLoopback = localDraftBaseUrl.length > 0 && !isLoopbackUrl(localDraftBaseUrl);
  const localModelHasDraft =
    localDraftBaseUrl.length > 0 ||
    localGenerationDraft.modelId.trim().length > 0 ||
    localGenerationDraft.apiKey.length > 0;
  const localModelHasSavedConfig =
    providerSettings.localGeneration.baseUrl.trim().length > 0 ||
    providerSettings.localGeneration.modelId.trim().length > 0;
  const showLocalModelFields =
    localModelEnabled || localModelSetupVisible || localModelHasDraft || localModelHasSavedConfig;

  // Advanced model settings (the Venice key and the local model) sit behind a
  // collapsed "More options" disclosure. Auto-expand it when a local model is
  // already enabled so the active toggle and endpoint config are never hidden
  // behind the disclosure. It only ever expands: a manual collapse, or a later
  // disable, is left as the user set it.
  useEffect(() => {
    if (localModelEnabled) {
      setShowMoreModelOptions(true);
      setLocalModelSetupVisible(true);
    }
  }, [localModelEnabled]);

  useEffect(() => {
    if (showingActiveProfileModels) closeModelPicker();
  }, [showingActiveProfileModels]);

  useEffect(() => {
    if (!pickerMode) return;
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (modelPickerPopoverRef.current?.contains(target)) return;
      if (modelPickerTriggerRef.current?.contains(target)) return;
      // The hover detail cards are portaled to document.body, so a click inside
      // one (its "Show more" toggle) lands outside the popover — treat it as in.
      if (target instanceof Element && target.closest(".agent-composer-model-hovercard")) return;
      closeModelPicker();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (modelPickerFlyout?.kind === "all") {
        setModelPickerFlyout(null);
        setModelSearch("");
      } else {
        closeModelPicker();
      }
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [pickerMode, modelPickerFlyout]);

  useEffect(() => {
    if (pickerMode === "image" || modelPickerFlyout?.kind === "all") {
      modelPickerSearchRef.current?.focus();
    }
  }, [pickerMode, modelPickerFlyout]);

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
    if (mode === "video") return VIDEO_GENERATION_ENABLED ? videoOptions : [];
    return generationOptions;
  }

  function modelValueForMode(mode: ProviderModelMode) {
    if (mode === "transcription") return displayProviderSettings.transcriptionModel;
    if (mode === "image") return displayProviderSettings.imageModel;
    if (mode === "video") return displayProviderSettings.videoModel;
    if (showingActiveProfileModels) {
      return activeProfileGenerationModel ?? globalGenerationModelValue();
    }
    return globalGenerationModelValue();
  }

  function globalGenerationModelValue() {
    if (localModelEnabled && providerSettings.localGeneration.modelId.trim()) {
      return localGenerationOptionId(providerSettings.localGeneration.modelId);
    }
    return providerSettings.generationModel;
  }

  function openModelPicker(mode: ProviderModelMode) {
    if (showingActiveProfileModels) return;
    if (mode === "image" && !IMAGE_GENERATION_ENABLED) return;
    if (mode === "video" && !VIDEO_GENERATION_ENABLED) return;
    setPickerMode(mode);
    setModelPickerFlyout(null);
    setModelSearch("");
    // Image and video models are curated local lists, not fetched catalogs.
    if (mode !== "image" && mode !== "video") void requestVeniceModels(mode);
  }

  function microphonePopoverStyle(): CSSProperties {
    return selectPopoverStyle(micPopoverPlacement, selectedMicrophoneIndex);
  }

  function languagePopoverStyle(): CSSProperties {
    return selectPopoverStyle(languagePopoverPlacement, selectedLanguageIndex);
  }

  return skillDetailOpen && openSkill ? (
    // Notes-parity drill-in: the detail shell replaces the settings page
    // entirely (pinned breadcrumb bar + its own scroll container), the same
    // way opening a meeting note swaps in note-shell.
    <SkillDetailSection skill={openSkill} onBack={() => setOpenSkill(null)} />
  ) : agentDetailOpen ? (
    // The agent messaging drill-in sits exactly where SkillDetailSection sits
    // (top level, replacing the settings page) so its BreadcrumbBar pins the
    // same way. It renders the SAME AgentSettingsSection with the SAME
    // controlled props as the nested placement below — only the position in the
    // tree differs, chosen synchronously from agentPlatformId.
    <AgentSettingsSection
      selectedPlatformId={agentPlatformId}
      onSelectPlatform={setAgentPlatformId}
      onBackFromPlatform={() => setAgentPlatformId(undefined)}
    />
  ) : (
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
            <SettingsPageHeader
              title="General"
              blurb="Your account and everyday June preferences."
            />
            <AccountSettingsSection
              account={account}
              loading={accountLoading}
              onAccountChanged={onAccountChanged}
              onRefresh={onAccountRefresh}
            />

            <PermissionsSettingsSection
              microphonePermissionStatus={microphonePermissionStatus}
              microphoneReadiness={microphoneReadiness}
              accessibilityPermissionStatus={accessibilityPermissionStatus}
              systemReadiness={systemReadiness}
              onEnableMicrophone={onEnableMicrophone}
              onEnableAccessibility={onEnableAccessibility}
              onEnableSystemAudio={onEnableSystemAudio}
            />

            <StartupSettingsSection />

            <PrivacySettingsSection />
          </>
        ) : null}

        {activeTab === "appearance" ? (
          <section className="settings-group" aria-labelledby="appearance-heading">
            <SettingsPageHeader
              id="appearance-heading"
              title="Appearance"
              blurb="Choose the theme, accent color, text size, and date format June uses."
            />
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
                    <h3 className="settings-row-title">Text size</h3>
                    <p className="settings-row-description">
                      Make text across the app larger. Affects every label, note, and conversation.
                    </p>
                  </div>
                  <div className="settings-row-control">
                    <SegmentedControl<FontScaleId>
                      aria-label="Text size"
                      value={fontScale}
                      options={FONT_SCALE_OPTIONS}
                      onValueChange={setStoredFontScale}
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
                    <Select
                      className="accent-select"
                      popoverWidth="trigger"
                      value={brand}
                      options={BRAND_PRESETS.map((preset) => ({
                        value: preset.id,
                        label: preset.label,
                        color: preset.value,
                      }))}
                      placeholder="Clay"
                      ariaLabel={`Accent color: ${
                        BRAND_PRESETS.find((preset) => preset.id === brand)?.label ??
                        BRAND_PRESETS[0].label
                      }`}
                      onChange={(id) => {
                        setBrand(id as BrandId);
                        setStoredBrand(id as BrandId);
                      }}
                    />
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <h3 className="settings-row-title">Date format</h3>
                    <p className="settings-row-description">
                      Choose how older session dates appear in the sidebar.
                    </p>
                  </div>
                  <div className="settings-row-control">
                    <Select
                      value={dateFormat}
                      options={DATE_FORMAT_OPTIONS}
                      placeholder="System"
                      ariaLabel={`Date format: ${
                        DATE_FORMAT_OPTIONS.find((option) => option.value === dateFormat)?.label ??
                        "System"
                      }`}
                      onChange={(value) => {
                        const next = value as DateFormatPreference;
                        setDateFormat(next);
                        setStoredDateFormat(next);
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === "billing" && !account.localDev ? (
          <BillingSettingsSection account={account} onRefresh={onAccountRefresh} />
        ) : null}

        {activeTab === "shortcuts" ? (
          <section className="settings-group" aria-labelledby="shortcuts-heading">
            <SettingsPageHeader
              id="shortcuts-heading"
              title="Shortcuts"
              blurb="Set the keyboard shortcuts that start dictation and control June."
            />
            {helperUnavailable ? (
              <InlineNotice
                role="alert"
                aria-label="Dictation unavailable"
                eyebrow={updateReadyToRelaunch ? "Relaunch to finish updating" : "Dictation paused"}
                body={
                  updateReadyToRelaunch
                    ? "Dictation is paused until you relaunch to finish updating."
                    : helperUnavailable.message
                }
                actions={
                  updateReadyToRelaunch && onRelaunch ? (
                    <button type="button" className="btn btn-secondary" onClick={onRelaunch}>
                      Relaunch June
                    </button>
                  ) : undefined
                }
              />
            ) : null}
            <div className="settings-card">
              <div className="settings-rows">
                {capabilities.shortcuts ? (
                  <>
                    <ShortcutRow
                      title="Push to talk"
                      description="Hold this shortcut to dictate, then release to paste."
                      shortcut={settings.pushToTalkShortcut}
                      defaultShortcut={defaultShortcuts.push_to_talk}
                      capturing={capturingShortcut === "push_to_talk"}
                      disabled={!!capturingShortcut && capturingShortcut !== "push_to_talk"}
                      error={shortcutErrorKind === "push_to_talk" ? shortcutError : undefined}
                      onChange={() => void startShortcutCapture("push_to_talk")}
                      onReset={() =>
                        void saveShortcut("push_to_talk", defaultShortcuts.push_to_talk)
                      }
                      onCancel={() => void cancelShortcutCapture()}
                      platform={capabilities.platform}
                    />

                    <ShortcutRow
                      title="Toggle dictation"
                      description="Press this shortcut to start or stop dictation."
                      shortcut={settings.toggleShortcut}
                      defaultShortcut={defaultShortcuts.toggle}
                      capturing={capturingShortcut === "toggle"}
                      disabled={!!capturingShortcut && capturingShortcut !== "toggle"}
                      error={shortcutErrorKind === "toggle" ? shortcutError : undefined}
                      onChange={() => void startShortcutCapture("toggle")}
                      onReset={() => void saveShortcut("toggle", defaultShortcuts.toggle)}
                      onCancel={() => void cancelShortcutCapture()}
                      platform={capabilities.platform}
                    />
                  </>
                ) : (
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <h3 className="settings-row-title">Dictation shortcuts unavailable</h3>
                      <p className="settings-row-description">
                        Global dictation shortcuts are not available on this device.
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
              <SettingsPageHeader
                id="dictation-heading"
                title="Dictation"
                blurb="Choose the language, microphone, and behavior for dictation."
              />
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
                                    {selected ? <IconCheckmark2Small size={14} /> : null}
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
            <SettingsPageHeader
              id="audio-heading"
              title="Audio"
              blurb={
                capabilities.platform === "windows"
                  ? "Control how June captures microphone audio on this device."
                  : "Control how June captures meeting and system audio."
              }
            />
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
                      // selectPopoverStyle offsets for the popover chrome and
                      // the trigger/row height difference, so the selected
                      // item overlays the trigger exactly with no visual jump.
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
                                  {selected ? <IconCheckmark2Small size={14} /> : null}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                </div>

                {capabilities.platform === "macos" || capabilities.platform === "windows" ? (
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
                        disabled={checkingSourceReadiness || systemLocked}
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
            <SettingsPageHeader
              title="Models"
              blurb="Choose the models June uses for transcription, notes, and agent responses."
            />
            <section
              className="settings-group settings-models-group"
              aria-labelledby="models-heading"
            >
              <h2 id="models-heading" className="settings-group-heading">
                AI models
              </h2>
              {showingActiveProfileModels ? (
                <p className="settings-models-profile-note">
                  Showing models for the active profile: {activeProfileName}. Switch to the default
                  profile to edit global models.
                </p>
              ) : null}
              <div className="settings-card settings-models-card">
                <div className="settings-rows">
                  <ModelRow
                    mode="transcription"
                    title="Transcription"
                    description="Speech-to-text for note recordings and dictation."
                    value={modelValueForMode("transcription")}
                    options={transcriptionOptions}
                    open={pickerMode === "transcription"}
                    summarySuppressed={pickerMode !== undefined}
                    flyout={modelPickerFlyout}
                    search={modelSearch}
                    triggerRef={modelPickerTriggerRef}
                    popoverRef={modelPickerPopoverRef}
                    searchRef={modelPickerSearchRef}
                    onToggle={() =>
                      pickerMode === "transcription"
                        ? closeModelPicker()
                        : openModelPicker("transcription")
                    }
                    onFlyoutChange={setModelPickerFlyout}
                    onSearchChange={setModelSearch}
                    onSelect={(modelId) => selectModelFromPicker("transcription", modelId)}
                    readOnly={showingActiveProfileModels}
                  />
                  <ModelRow
                    mode="generation"
                    title="Text"
                    description="Used for generated notes and agent responses."
                    value={modelValueForMode("generation")}
                    options={generationOptions}
                    costQuality={providerSettings.costQuality}
                    veniceApiKeyConfigured={providerSettings.veniceApiKeyConfigured}
                    open={pickerMode === "generation"}
                    summarySuppressed={pickerMode !== undefined}
                    flyout={modelPickerFlyout}
                    search={modelSearch}
                    triggerRef={modelPickerTriggerRef}
                    popoverRef={modelPickerPopoverRef}
                    searchRef={modelPickerSearchRef}
                    onToggle={() =>
                      pickerMode === "generation"
                        ? closeModelPicker()
                        : openModelPicker("generation")
                    }
                    onFlyoutChange={setModelPickerFlyout}
                    onSearchChange={setModelSearch}
                    onSelect={(modelId, costQuality, options) =>
                      selectModelFromPicker("generation", modelId, costQuality, options)
                    }
                    onCostQualityChange={applyCostQuality}
                    readOnly={showingActiveProfileModels}
                  />
                  {providerSettings.generationModel === "open-software/auto" ? (
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-row-title">Auto preference</span>
                        <span className="settings-row-description">
                          Choose how June balances model quality and usage cost.
                        </span>
                        {providerSettings.veniceApiKeyConfigured ? (
                          <span className="settings-row-description settings-row-substatus">
                            Auto does not use your Venice API key for notes or chat. Choose a Venice
                            model above to use your key for notes and new chats.
                          </span>
                        ) : null}
                      </div>
                      <div className="settings-row-control">
                        <SegmentedControl<AutoPreference>
                          aria-label="Auto preference"
                          value={autoPreferenceFromCostQuality(providerSettings.costQuality)}
                          options={AUTO_PREFERENCE_OPTIONS}
                          onValueChange={(preference) =>
                            applyCostQuality(AUTO_PREFERENCE_VALUES[preference])
                          }
                        />
                      </div>
                    </div>
                  ) : null}
                  <div className="settings-row-divider" aria-hidden />
                  <button
                    type="button"
                    className="settings-more-options-trigger settings-more-options-row"
                    aria-label="More options for AI models"
                    aria-expanded={showMoreModelOptions}
                    aria-controls="models-more-options-panel"
                    onClick={() => setShowMoreModelOptions((open) => !open)}
                  >
                    <span className="settings-row-info">
                      <span className="settings-row-title">More options</span>
                      <span className="settings-row-description">Advanced model settings</span>
                    </span>
                    <IconChevronDownSmall
                      className="settings-more-options-chevron"
                      size={14}
                      aria-hidden
                    />
                  </button>
                  {showMoreModelOptions ? (
                    <div id="models-more-options-panel" className="settings-more-options-panel">
                      <div className="settings-row">
                        <div className="settings-row-info">
                          <h3 className="settings-row-title">Live transcription</h3>
                          <p className="settings-row-description">
                            Show a live transcript while you record. This transcribes audio twice,
                            so it may use extra credits; turning it off shows the transcript only
                            after the recording ends.
                          </p>
                        </div>
                        <div className="settings-row-control">
                          <Switch
                            checked={providerSettings.liveTranscription}
                            aria-label="Show a live transcript while recording"
                            onCheckedChange={toggleLiveTranscription}
                          />
                        </div>
                      </div>
                      <VeniceApiKeyRow
                        configured={providerSettings.veniceApiKeyConfigured}
                        value={veniceApiKeyDraft}
                        onValueChange={setVeniceApiKeyDraft}
                        onSave={() => void saveVeniceApiKey()}
                        onRemove={() => void removeVeniceApiKey()}
                      />
                      <div className="settings-row settings-local-model-toggle-row">
                        <div className="settings-row-info">
                          <h3 className="settings-row-title">Use local model</h3>
                          <p className="settings-row-description">
                            Route generated notes and agent responses through your own
                            OpenAI-compatible endpoint.
                          </p>
                        </div>
                        <div className="settings-row-control">
                          <Switch
                            checked={localModelEnabled}
                            aria-label="Use local text model"
                            onCheckedChange={handleLocalToggle}
                          />
                        </div>
                      </div>

                      {showLocalModelFields ? (
                        <div className="settings-row settings-row-stack settings-local-model-fields-row">
                          <div className="settings-row-info">
                            <h3 className="settings-row-title">Endpoint</h3>
                            <p className="settings-row-description">
                              Add the base URL, model ID, and optional API key for your local text
                              model.
                            </p>
                          </div>
                          <div className="settings-row-control settings-local-model-fields">
                            <label className="settings-field">
                              <span>Base URL</span>
                              <input
                                value={localGenerationDraft.baseUrl}
                                onChange={(event) => {
                                  const baseUrl = event.currentTarget.value;
                                  setLocalGenerationDraft((draft) => ({
                                    ...draft,
                                    baseUrl,
                                  }));
                                  setLocalEnableConfirm(false);
                                  setLocalModelStatus(undefined);
                                }}
                                placeholder="http://localhost:11434/v1"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                              />
                            </label>
                            <label className="settings-field">
                              <span>Model ID</span>
                              <input
                                value={localGenerationDraft.modelId}
                                onChange={(event) => {
                                  const modelId = event.currentTarget.value;
                                  setLocalGenerationDraft((draft) => ({
                                    ...draft,
                                    modelId,
                                  }));
                                  setLocalModelStatus(undefined);
                                }}
                                placeholder="llama3.1:8b"
                                list="local-generation-models"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                              />
                              <datalist id="local-generation-models">
                                {localProbeModels.map((id) => (
                                  <option key={id} value={id} />
                                ))}
                              </datalist>
                            </label>
                            <label className="settings-field">
                              <span>Local API key</span>
                              <input
                                type="password"
                                value={localGenerationDraft.apiKey}
                                onChange={(event) => {
                                  const apiKey = event.currentTarget.value;
                                  setLocalGenerationDraft((draft) => ({
                                    ...draft,
                                    apiKey,
                                  }));
                                  setLocalModelStatus(undefined);
                                }}
                                placeholder="Optional"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                              />
                            </label>
                            {localNonLoopback ? (
                              <p className="settings-local-model-warning" role="note">
                                This endpoint is not on this machine. Requests will leave your
                                device.
                              </p>
                            ) : null}
                            <div className="settings-local-model-actions">
                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => void testLocalConnection()}
                              >
                                Test connection
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => void handleSaveLocalModel()}
                              >
                                Save local model
                              </button>
                            </div>
                            {localModelStatus ? (
                              <p className="settings-local-model-status" role="status">
                                {localModelStatus}
                              </p>
                            ) : null}
                            {localEnableConfirm ? (
                              <div className="settings-local-model-confirm" role="alert">
                                <p className="settings-row-error">
                                  This endpoint is not on this machine. Requests will leave your
                                  device.
                                </p>
                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  onClick={() => void enableLocalGeneration()}
                                >
                                  Enable anyway
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </section>

            <ConfirmDialog
              open={veniceKeyAutoBillingChoiceOpen}
              onClose={() => setVeniceKeyAutoBillingChoiceOpen(false)}
              onConfirm={async () => {
                const switched = await selectVeniceModel(
                  "generation",
                  veniceKeySwitchTarget?.id ?? DEFAULT_GENERATION_SUGGESTION_ID,
                );
                // Keep the dialog open over a failed save so the choice is
                // never silently dropped; the status line carries the error.
                if (!switched) throw new Error("venice_model_switch_failed");
              }}
              title="Auto does not use your Venice API key"
              description={`Notes and chat are billed to June credits while Auto is selected. Switch to ${veniceKeySwitchTarget?.name ?? "a Venice model"} to use your key for notes and new chats.`}
              confirmLabel={`Use ${veniceKeySwitchTarget?.name ?? "a Venice model"}`}
              cancelLabel="Keep Auto"
            />

            {IMAGE_GENERATION_ENABLED || VIDEO_GENERATION_ENABLED ? (
              <section
                className="settings-group settings-models-group"
                aria-labelledby="media-generation-heading"
              >
                <h2 id="media-generation-heading" className="settings-group-heading">
                  Image and video
                </h2>
                <p className="settings-group-description">
                  Choose the models June uses when you ask it to generate an image or video.
                </p>
                {showingActiveProfileModels ? (
                  <p className="settings-models-profile-note">
                    Showing models for the active profile: {activeProfileName}. Switch to the
                    default profile to edit global models.
                  </p>
                ) : null}
                <div className="settings-card settings-models-card">
                  <div className="settings-rows">
                    {IMAGE_GENERATION_ENABLED ? (
                      <ModelRow
                        mode="image"
                        title="Image"
                        description="Used when you generate an image from chat."
                        value={modelValueForMode("image")}
                        options={imageOptions}
                        open={pickerMode === "image"}
                        summarySuppressed={pickerMode !== undefined}
                        flyout={modelPickerFlyout}
                        search={modelSearch}
                        triggerRef={modelPickerTriggerRef}
                        popoverRef={modelPickerPopoverRef}
                        searchRef={modelPickerSearchRef}
                        onToggle={() =>
                          pickerMode === "image" ? closeModelPicker() : openModelPicker("image")
                        }
                        onFlyoutChange={setModelPickerFlyout}
                        onSearchChange={setModelSearch}
                        onSelect={(modelId) => selectModelFromPicker("image", modelId)}
                        readOnly={showingActiveProfileModels}
                      />
                    ) : null}
                    {VIDEO_GENERATION_ENABLED ? (
                      <ModelRow
                        mode="video"
                        title="Video"
                        description="Used when you generate a video from chat."
                        value={modelValueForMode("video")}
                        options={videoOptions}
                        open={pickerMode === "video"}
                        summarySuppressed={pickerMode !== undefined}
                        flyout={modelPickerFlyout}
                        search={modelSearch}
                        triggerRef={modelPickerTriggerRef}
                        popoverRef={modelPickerPopoverRef}
                        searchRef={modelPickerSearchRef}
                        onToggle={() =>
                          pickerMode === "video" ? closeModelPicker() : openModelPicker("video")
                        }
                        onFlyoutChange={setModelPickerFlyout}
                        onSearchChange={setModelSearch}
                        onSelect={(modelId) => selectModelFromPicker("video", modelId)}
                        readOnly={showingActiveProfileModels}
                      />
                    ) : null}
                    <div className="settings-row-divider" aria-hidden />
                    <button
                      type="button"
                      className="settings-more-options-trigger settings-more-options-row"
                      aria-label="More options for image and video"
                      aria-expanded={showMoreImageOptions}
                      aria-controls="image-more-options-panel"
                      onClick={() => setShowMoreImageOptions((open) => !open)}
                    >
                      <span className="settings-row-info">
                        <span className="settings-row-title">More options</span>
                        <span className="settings-row-description">
                          Advanced image and video settings
                        </span>
                      </span>
                      <IconChevronDownSmall
                        className="settings-more-options-chevron"
                        size={14}
                        aria-hidden
                      />
                    </button>
                    {showMoreImageOptions ? (
                      <div id="image-more-options-panel" className="settings-more-options-panel">
                        <div className="settings-row">
                          <div className="settings-row-info">
                            <h3 className="settings-row-title">Safe mode</h3>
                            <p className="settings-row-description">
                              {VIDEO_GENERATION_ENABLED
                                ? "Blur adult content in generated and edited images, and hold back video prompts that request it (videos cannot be blurred). On by default; your image and video work stays private either way."
                                : "Blur adult content in generated and edited images. On by default; your image work stays private either way."}
                            </p>
                          </div>
                          <div className="settings-row-control">
                            <Switch
                              checked={providerSettings.imageSafeMode}
                              aria-label="Blur adult content in images"
                              onCheckedChange={toggleImageSafeMode}
                            />
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </section>
            ) : null}

            {status ? (
              <p className="settings-status" role="status">
                {status}
              </p>
            ) : null}
          </>
        ) : null}

        {activeTab === "agent" ? (
          <AgentSettingsSection
            selectedPlatformId={agentPlatformId}
            onSelectPlatform={setAgentPlatformId}
            onBackFromPlatform={() => setAgentPlatformId(undefined)}
            folders={folders}
            onFoldersImported={onFoldersImported}
          />
        ) : null}

        {activeTab === "memory" ? (
          <MemorySettingsSection
            folders={folders}
            initialFolderFilter={memoryFolderFilter}
            onOpenProject={onOpenProject}
          />
        ) : null}

        {activeTab === "connectors" ? (
          <ConnectorsSection
            onOpenModels={() => setActiveTab("models")}
            onOpenBilling={() => setActiveTab("billing")}
          />
        ) : null}

        {activeTab === "skills" ? <InstalledSkillsSection onOpenSkill={setOpenSkill} /> : null}
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
            <SettingsPageHeader
              id="about-heading"
              title="About"
              blurb="Version, release channel, and other details about this copy of June."
            />
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
                        Describe the problem, attach files if you have them, and send the report to
                        the June team.
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

/** Launch-at-login toggle. Reads and writes the OS login item directly (the
 * LaunchAgent is the single source of truth), so state here can never drift
 * from what System Settings shows. Hidden in browser previews, where no
 * autostart backend exists. */
function StartupSettingsSection() {
  const [enabled, setEnabled] = useState<boolean>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!autostartSupported()) return;
    let cancelled = false;
    autostartEnabled()
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch(() => {
        if (!cancelled) setError("Could not read the login item state.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(next: boolean) {
    setSaving(true);
    setError(undefined);
    try {
      await setAutostartEnabled(next);
      setEnabled(next);
    } catch {
      setError("Could not update the login item. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!autostartSupported() || (enabled === undefined && !error)) return null;

  return (
    <section className="settings-group" aria-labelledby="startup-heading">
      <h2 id="startup-heading" className="settings-group-heading">
        Startup
      </h2>
      <p className="settings-group-description">
        Dictation shortcuts, meeting detection, and scheduled routines only work while June is
        running.
      </p>
      <div className="settings-card">
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">Open June at login</h3>
              <p className="settings-row-description">
                Start June automatically when you sign in to your computer.
              </p>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={enabled === true}
                disabled={saving || enabled === undefined}
                aria-label="Open June at login"
                onCheckedChange={(next) => void toggle(next)}
              />
            </div>
          </div>
          {error ? <p className="settings-row-description">{error}</p> : null}
        </div>
      </div>
    </section>
  );
}

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
  const macLikePlatform = fallbackDictationCapabilities().platform === "macos";
  const systemAudioSupportedPlatform = isSystemAudioSupportedPlatform();
  return (
    <section className="settings-group" aria-labelledby="permissions-heading">
      <h2 id="permissions-heading" className="settings-group-heading">
        {macLikePlatform ? "System permissions" : "Audio access"}
      </h2>
      <p className="settings-group-description">
        {macLikePlatform
          ? "macOS access used for recording audio, pasting dictation, and capturing system sound."
          : systemAudioSupportedPlatform
            ? "Audio sources available for recording microphone and app audio."
            : "Audio sources available for recording microphone audio."}
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

              {systemAudioSupportedPlatform ? (
                <PermissionRow
                  title="System audio"
                  description="Record audio from other apps when system audio is enabled."
                  status={sourcePermissionStatus(systemReadiness, macLikePlatform)}
                  onManage={onEnableSystemAudio}
                />
              ) : null}
            </>
          ) : systemAudioSupportedPlatform ? (
            <PermissionRow
              title="System audio"
              description="Record audio from other apps when system audio is enabled."
              status={sourcePermissionStatus(systemReadiness, macLikePlatform)}
            />
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
  actionLabel,
  actionText = "Manage",
}: {
  title: string;
  description: string;
  status: PermissionStatusView;
  onManage?: () => void;
  actionLabel?: string;
  actionText?: string;
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
        {onManage ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={actionDisabled}
            aria-label={actionLabel ?? `Manage ${title} permission`}
            onClick={onManage}
          >
            {actionText}
          </button>
        ) : null}
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
    case "unavailable":
      return { label: "No microphone found", tone: "attention" };
    case "unsupported":
      return { label: "Unsupported", tone: "unsupported" };
    case "unknown":
      return { label: "Unknown", tone: "unknown" };
    default:
      return { label: "Checking", tone: "unknown" };
  }
}

function sourcePermissionStatus(
  source: RecordingSourceReadinessDto["sources"][number] | undefined,
  macLikePlatform: boolean,
): PermissionStatusView {
  if (!source) return { label: "Checking", tone: "unknown" };
  // The two halves are independent: permissionState is the platform grant or
  // endpoint status, while `ready` says whether this device can actually
  // capture. A microphone-only check never asks for the grant/status, and a
  // granted source can still be uncapturable.
  if (source.permissionState === "granted") {
    return source.ready
      ? { label: macLikePlatform ? "Allowed" : "Available", tone: "allowed" }
      : { label: "Unavailable", tone: "attention" };
  }
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
  mode,
  title,
  description,
  value,
  options,
  costQuality,
  veniceApiKeyConfigured,
  open,
  flyout,
  search,
  triggerRef,
  popoverRef,
  searchRef,
  onToggle,
  onFlyoutChange,
  onSearchChange,
  onSelect,
  onCostQualityChange,
  readOnly = false,
  summarySuppressed,
}: {
  mode: ProviderModelMode;
  title: string;
  description: string;
  value: string;
  options: VeniceModelDto[];
  costQuality?: number;
  veniceApiKeyConfigured?: boolean;
  open: boolean;
  flyout: ModelPickerFlyout;
  search: string;
  triggerRef: RefObject<HTMLButtonElement>;
  popoverRef: RefObject<HTMLDivElement>;
  searchRef: RefObject<HTMLInputElement>;
  onToggle: () => void;
  onFlyoutChange: (flyout: ModelPickerFlyout) => void;
  onSearchChange: (value: string) => void;
  onSelect: (modelId: string, costQuality?: number, options?: { keepOpen?: boolean }) => void;
  onCostQualityChange?: (value: number) => void;
  readOnly?: boolean;
  summarySuppressed?: boolean;
}) {
  const model = selectedModel(options, value);
  const modelLabel = `${title.toLowerCase()} model`;
  return (
    <div className="settings-row settings-model-row">
      <div className="settings-row-info">
        <h3 className="settings-row-title">{title}</h3>
        <p className="settings-row-description">{description}</p>
      </div>
      <div className="settings-row-control settings-model-control">
        <HoverTip
          tip={<ModelSummaryHoverDetails model={model} />}
          className="model-summary-tip-anchor"
          width={280}
          delay={280}
          suppressed={summarySuppressed || open}
          interactive
        >
          <button
            ref={open && !readOnly ? triggerRef : undefined}
            type="button"
            className="model-summary-button"
            onClick={readOnly ? undefined : onToggle}
            aria-label={`Change ${modelLabel}`}
            aria-haspopup="dialog"
            aria-expanded={readOnly ? false : open}
            disabled={readOnly}
          >
            <span className="model-summary-logo" aria-hidden>
              <ProviderLogo provider={model.provider} id={model.id} name={model.name} />
            </span>
            <span className="model-summary-name">{model.name}</span>
            <IconChevronDownSmall size={14} aria-hidden />
          </button>
        </HoverTip>
        {open && !readOnly ? (
          <ModelPickerPopover
            mode={mode}
            flyout={flyout}
            model={model}
            options={options}
            costQuality={costQuality}
            veniceApiKeyConfigured={veniceApiKeyConfigured}
            search={search}
            popoverRef={popoverRef}
            searchRef={searchRef}
            className="settings-model-popover"
            title={modelLabel[0].toUpperCase() + modelLabel.slice(1)}
            ariaLabel={`Choose ${modelLabel}`}
            onFlyoutChange={onFlyoutChange}
            onSearchChange={onSearchChange}
            onSelect={onSelect}
            onCostQualityChange={onCostQualityChange}
          />
        ) : null}
      </div>
    </div>
  );
}

function ModelSummaryHoverDetails({ model }: { model: VeniceModelDto }) {
  return (
    <div className="agent-composer-model-detail model-summary-hovercard">
      {/* Read-only summary card: full description in one hover (the card shows
          it in a capped scroll box; there is no "Show more" toggle anywhere). */}
      <ModelPickerCardContent model={model} withDescription />
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
          only for Venice requests. For least privilege, use an inference-only key.
        </p>
        {configured ? (
          <p className="settings-row-description settings-row-substatus">Key saved.</p>
        ) : null}
      </div>
      <div className="settings-row-control settings-secret-control">
        <label className="settings-field settings-secret-field">
          <span>API key</span>
          <input
            type="password"
            className="dialog-input"
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
        </label>
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
  platform,
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
  platform: "macos" | "windows" | "unsupported";
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
        <KeycapShortcut label={shortcut.label} capturing={capturing} platform={platform} />
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

function shortcutKindPayload(value: unknown): DictationShortcutKind | undefined {
  return value === "push_to_talk" || value === "toggle" ? value : undefined;
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
