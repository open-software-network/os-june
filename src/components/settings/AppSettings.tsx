import { listen } from "@tauri-apps/api/event";
import { IconAnonymous } from "central-icons/IconAnonymous";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCircleQuestionmark } from "central-icons/IconCircleQuestionmark";
import { IconCircleX } from "central-icons/IconCircleX";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconFire1 } from "central-icons/IconFire1";
import { IconGhost2 } from "central-icons/IconGhost2";
import { IconLock } from "central-icons/IconLock";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMoonStar } from "central-icons/IconMoonStar";
import { IconSun } from "central-icons/IconSun";
import { IconTelevision } from "central-icons/IconTelevision";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  dictationHelperCommand,
  dictationSettings,
  listVeniceModels,
  localAudioFileSrc,
  providerModelSettings,
  scribeOpenVerifyPage,
  setDictationLanguage,
  setDictationMicrophone,
  setDictationShortcut,
  setVeniceModel,
} from "../../lib/tauri";
import { LANGUAGE_OPTIONS, languageLabel } from "../../lib/dictation-languages";
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
import {
  AccountSettingsSection,
  BillingSettingsSection,
} from "../account/AccountSettings";
import { KeycapShortcut } from "../shortcuts/KeycapShortcut";
import { Dialog } from "../ui/Dialog";
import { HoverTip } from "../ui/HoverTip";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Switch } from "../ui/Switch";
import { APP_COMMIT_HASH, APP_VERSION } from "../../app/build-info";
import {
  getStoredTheme,
  setStoredTheme,
  type ThemePreference,
} from "../../lib/theme";
import { parseDictationHelperEvent } from "../../lib/dictation-events";
import {
  dispatchProviderModelSettingsChanged,
  modelPrivacyBadge,
  modelPrivacyFlags,
  modelSupportsTools,
} from "../../lib/model-privacy";
import { suggestedModelsForMode } from "../../lib/suggested-models";
import { ProviderLogo } from "./ProviderLogo";
import { AgentSettingsSection } from "./AgentSettingsSection";
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

const DEFAULT_SHORTCUTS: Record<
  DictationShortcutKind,
  DictationShortcutSetting
> = {
  push_to_talk: DEFAULT_SETTINGS.pushToTalkShortcut,
  toggle: DEFAULT_SETTINGS.toggleShortcut,
};

const DEFAULT_PROVIDER_MODELS: ProviderModelSettingsDto = {
  transcriptionProvider: "venice",
  transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
  generationModel: "zai-org-glm-5",
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
  | "about";

type SelectPopoverPlacement = "align-selected" | "below" | "above";

export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "billing", label: "Billing" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "dictation", label: "Dictation" },
  { id: "audio", label: "Audio" },
  { id: "models", label: "Models" },
  { id: "agent", label: "Agent" },
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
  // Opens a new agent session prefilled with the bug report template.
  onReportIssue?: () => void;
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
  onReportIssue,
}: AppSettingsProps) {
  const [settings, setSettings] =
    useState<DictationSettingsDto>(DEFAULT_SETTINGS);
  const [providerSettings, setProviderSettings] =
    useState<ProviderModelSettingsDto>(DEFAULT_PROVIDER_MODELS);
  const [veniceModels, setVeniceModels] = useState<
    Record<ProviderModelMode, VeniceModelDto[]>
  >({
    transcription: [],
    generation: [],
  });
  const [microphones, setMicrophones] = useState<
    DictationMicrophoneDeviceDto[]
  >([]);
  const [defaultMicrophone, setDefaultMicrophone] =
    useState<DictationMicrophoneDeviceDto>();
  const [capturingShortcut, setCapturingShortcut] =
    useState<DictationShortcutKind>();
  const capturingShortcutRef = useRef<DictationShortcutKind>();
  const [shortcutError, setShortcutError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [micOpen, setMicOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(() => getStoredTheme());
  const [pickerMode, setPickerMode] = useState<ProviderModelMode>();
  const [modelSearch, setModelSearch] = useState("");
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
  const systemReadiness = sourceReadiness?.sources.find(
    (source) => source.source === "system",
  );
  const microphoneReadiness = sourceReadiness?.sources.find(
    (source) => source.source === "microphone",
  );
  const systemState = systemReadiness?.permissionState;
  const systemDenied = systemState === "denied" || systemState === "restricted";
  const systemUnsupported = systemState === "unsupported";

  useEffect(() => {
    capturingShortcutRef.current = capturingShortcut;
  }, [capturingShortcut]);

  useEffect(() => {
    setMicOpen(false);
    setLanguageOpen(false);
    if (activeTab !== "audio" && micTestState !== "idle") {
      void resetMicTestState(true);
    }
  }, [activeTab]);

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
        setProviderSettings(modelResponse.settings);
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

  useEffect(() => {
    if (!capturingShortcut) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        void cancelShortcutCapture();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
      const message =
        helperEvent.payload?.message ?? "Microphone test could not record.";
      setMicTestState("error");
      setMicTestStartedAt(undefined);
      setMicTestError(message);
      setMicTestPlaying(false);
      setStatus(message);
      return;
    }
    if (helperEvent.type === "fn_monitor_unavailable") {
      setStatus(
        helperEvent.payload?.message ??
          "Global shortcut monitoring is unavailable.",
      );
      return;
    }
    if (helperEvent.type === "shortcut_capture_started") {
      setStatus("Press the shortcut to record it.");
      return;
    }
    if (helperEvent.type === "shortcut_capture_error") {
      const message =
        helperEvent.payload?.message ?? "Shortcut could not be captured.";
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
      const shortcut = shortcutFromCapturePayload(
        helperEvent.payload?.shortcut,
        1,
      );
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
      setStatus(
        name ? `Microphone set to ${name}.` : "Microphone set to auto-detect.",
      );
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function saveShortcut(
    kind: DictationShortcutKind,
    shortcut: Pick<
      DictationShortcutSetting,
      "code" | "modifiers" | "label" | "pressCount"
    >,
  ) {
    try {
      const next = await setDictationShortcut(kind, shortcut);
      setSettings(next);
      setCapturingShortcut(undefined);
      setStatus(
        `${shortcutKindLabel(kind)} set to ${shortcutForKind(next, kind).label}.`,
      );
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
          : "Text model updated.",
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
      : "Auto-detect uses the current macOS input.";
  const microphoneOptions = [
    { id: undefined, name: "Auto-detect" },
    ...microphones,
  ];
  const selectedMicrophoneIndex = Math.max(
    0,
    microphoneOptions.findIndex(
      (option) => (option.id ?? "") === (settings.microphone.id ?? ""),
    ),
  );
  const selectedLanguageIndex = Math.max(
    0,
    LANGUAGE_OPTIONS.findIndex(
      (option) => option.value === (settings.language ?? ""),
    ),
  );
  const transcriptionOptions = modelOptions(
    veniceModels.transcription,
    providerSettings.transcriptionModel,
  );
  const generationOptions = modelOptions(
    veniceModels.generation,
    providerSettings.generationModel,
  );
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
      selectPopoverPlacement(
        micWrapRef.current,
        microphoneOptions.length,
        selectedMicrophoneIndex,
      ),
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
    return mode === "transcription" ? transcriptionOptions : generationOptions;
  }

  function modelValueForMode(mode: ProviderModelMode) {
    return mode === "transcription"
      ? providerSettings.transcriptionModel
      : providerSettings.generationModel;
  }

  function openModelPicker(mode: ProviderModelMode) {
    setPickerMode(mode);
    setModelSearch("");
    void requestVeniceModels(mode);
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

          <nav
            className="settings-nav"
            role="tablist"
            aria-label="Settings sections"
          >
            {SETTINGS_TABS.map((tab) => (
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

            <section
              className="settings-group"
              aria-labelledby="appearance-heading"
            >
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

        {activeTab === "billing" ? (
          <BillingSettingsSection
            account={account}
            onRefresh={onAccountRefresh}
          />
        ) : null}

        {activeTab === "shortcuts" ? (
          <section
            className="settings-group"
            aria-labelledby="shortcuts-heading"
          >
            <h2 id="shortcuts-heading" className="settings-group-heading">
              Shortcuts
            </h2>
            <div className="settings-card">
              <div className="settings-rows">
                <ShortcutRow
                  title="Push to talk"
                  description="Hold this shortcut to dictate, then release to paste."
                  shortcut={settings.pushToTalkShortcut}
                  defaultShortcut={DEFAULT_SHORTCUTS.push_to_talk}
                  capturing={capturingShortcut === "push_to_talk"}
                  disabled={
                    !!capturingShortcut && capturingShortcut !== "push_to_talk"
                  }
                  error={
                    capturingShortcut === "push_to_talk"
                      ? shortcutError
                      : undefined
                  }
                  onChange={() => void startShortcutCapture("push_to_talk")}
                  onReset={() =>
                    void saveShortcut(
                      "push_to_talk",
                      DEFAULT_SHORTCUTS.push_to_talk,
                    )
                  }
                  onCancel={() => void cancelShortcutCapture()}
                />

                <ShortcutRow
                  title="Toggle dictation"
                  description="Press this shortcut to start or stop dictation."
                  shortcut={settings.toggleShortcut}
                  defaultShortcut={DEFAULT_SHORTCUTS.toggle}
                  capturing={capturingShortcut === "toggle"}
                  disabled={
                    !!capturingShortcut && capturingShortcut !== "toggle"
                  }
                  error={
                    capturingShortcut === "toggle" ? shortcutError : undefined
                  }
                  onChange={() => void startShortcutCapture("toggle")}
                  onReset={() =>
                    void saveShortcut("toggle", DEFAULT_SHORTCUTS.toggle)
                  }
                  onCancel={() => void cancelShortcutCapture()}
                />
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === "dictation" ? (
          <>
            <section
              className="settings-group"
              aria-labelledby="dictation-heading"
            >
              <h2 id="dictation-heading" className="settings-group-heading">
                Dictation
              </h2>
              <div className="settings-card">
                <div className="settings-rows">
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <h3 className="settings-row-title">Language</h3>
                      <p className="settings-row-description">
                        Default language hint for note transcription and
                        dictation.
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
                            const selected =
                              option.value === (settings.language ?? "");
                            return (
                              <li key={option.value || "auto"}>
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={selected}
                                  data-selected={selected}
                                  onClick={() =>
                                    void selectLanguage(option.value)
                                  }
                                >
                                  <span>{option.label}</span>
                                  <span className="select-check" aria-hidden>
                                    {selected ? (
                                      <IconCheckmark1Small size={14} />
                                    ) : null}
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
                    <p className="settings-row-description">
                      {microphoneDescription}
                    </p>
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
                          const selected =
                            (option.id ?? "") ===
                            (settings.microphone.id ?? "");
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
                                  {selected ? (
                                    <IconCheckmark1Small size={14} />
                                  ) : null}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                </div>

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
                    setMicTestError(
                      "Microphone test recorded, but playback is unavailable.",
                    );
                  }}
                  onPlayingChange={setMicTestPlaying}
                />

                {systemUnsupported ? null : (
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <h3 className="settings-row-title">System audio</h3>
                      <p className="settings-row-description">
                        Capture audio from other apps along with your
                        microphone.
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
                          onSourceModeChange(
                            next ? "microphonePlusSystem" : "microphoneOnly",
                          )
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

            <section
              className="settings-group"
              aria-labelledby="models-heading"
            >
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
                </div>
              </div>
            </section>
          </>
        ) : null}

        {activeTab === "agent" ? <AgentSettingsSection /> : null}

        {activeTab === "about" ? (
          <section className="settings-group" aria-labelledby="about-heading">
            <h2 id="about-heading" className="settings-group-heading">
              About
            </h2>
            <div className="settings-card">
              <div className="settings-rows">
                <div className="settings-row settings-row-meta">
                  <div className="settings-row-info">
                    <h3 className="settings-row-title settings-meta-label">
                      Release version
                    </h3>
                  </div>
                  <div className="settings-row-control">
                    <span className="settings-meta-value">{APP_VERSION}</span>
                  </div>
                </div>

                <div className="settings-row settings-row-meta">
                  <div className="settings-row-info">
                    <h3 className="settings-row-title settings-meta-label">
                      Commit
                    </h3>
                  </div>
                  <div className="settings-row-control">
                    <span className="settings-meta-value settings-meta-value-mono">
                      {APP_COMMIT_HASH}
                    </span>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-row-info">
                    <h3 className="settings-row-title">
                      Server verification
                    </h3>
                    <p className="settings-row-description">
                      June&apos;s server runs in a confidential VM. See
                      exactly what code is running and how to verify it
                      yourself.
                    </p>
                  </div>
                  <div className="settings-row-control">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() =>
                        void scribeOpenVerifyPage().catch(() => undefined)
                      }
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
                        Something not working? Describe it to June, attach a
                        screenshot if you have one, and June will send the
                        report to the team along with its own diagnosis.
                      </p>
                    </div>
                    <div className="settings-row-control">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={onReportIssue}
                      >
                        Report an issue
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

type PermissionStatusTone =
  | "allowed"
  | "attention"
  | "blocked"
  | "unsupported"
  | "unknown";

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
  return (
    <section className="settings-group" aria-labelledby="permissions-heading">
      <h2 id="permissions-heading" className="settings-group-heading">
        System permissions
      </h2>
      <p className="settings-group-description">
        macOS access used for recording audio, pasting dictation, and capturing
        system sound.
      </p>
      <div className="settings-card">
        <div className="settings-rows">
          <PermissionRow
            title="Microphone"
            description="Record dictation and note audio."
            status={permissionStatus(
              microphonePermissionStatus ??
                microphoneReadiness?.permissionState,
            )}
            onManage={onEnableMicrophone}
          />

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
            <ProviderLogo
              provider={model.provider}
              id={model.id}
              name={model.name}
            />
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

function ModelMeta({ model }: { model: VeniceModelDto }) {
  const flags = modelPrivacyFlags(model);
  const privacyBadge = modelPrivacyBadge(model, flags);
  const context = contextLabel(model);
  const price = pricingLabel(model);
  const items: ReactNode[] = [];
  if (price) items.push(<span className="model-meta-price">{price}</span>);
  if (context) items.push(<span>{context}</span>);
  if (privacyBadge) {
    items.push(
      <HoverTip
        tip={privacyBadge.description}
        className="model-trait-icon"
        data-mode={privacyBadge.mode}
        tabIndex={0}
        aria-label={`${privacyBadge.label} — ${privacyBadge.description}`}
      >
        {privacyBadge.mode === "e2ee" ? (
          <IconLock size={14} />
        ) : privacyBadge.mode === "private" ? (
          <IconGhost2 size={14} />
        ) : (
          <IconAnonymous size={14} />
        )}
        <span>{privacyBadge.label}</span>
      </HoverTip>,
    );
  }
  if (flags.uncensored) {
    items.push(
      <span className="model-trait-icon" title="Uncensored">
        <IconFire1 size={14} />
        <span>Uncensored</span>
      </span>,
    );
  }
  if (items.length === 0) {
    items.push(<span>Model details unavailable</span>);
  }
  return (
    <span className="model-meta-items">
      {items.map((item, index) => (
        <span className="model-meta-item" key={index}>
          {index > 0 ? (
            <span className="model-meta-sep" aria-hidden>
              ·
            </span>
          ) : null}
          {item}
        </span>
      ))}
    </span>
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
  const canReset =
    !capturing && !shortcutsMatch(shortcut, defaultShortcut) && !disabled;

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

const NO_TOOLS_MODEL_EXPLANATION =
  "This model can't use tools, so June's agent can't work with it. Pick a tool-capable model to use June.";

function ModelPickerDialog({
  open,
  mode,
  value,
  options,
  search,
  onSearchChange,
  onClose,
  onSelect,
}: {
  open: boolean;
  mode: ProviderModelMode;
  value: string;
  options: VeniceModelDto[];
  search: string;
  onSearchChange: (value: string) => void;
  onClose: () => void;
  onSelect: (modelId: string) => void;
}) {
  // "Suggested" leads with the few models we actually recommend (benchmarks,
  // price, tool use, privacy — see SUGGESTED_MODELS); "All" is the full
  // catalog. Suggested is the default on every open; typing a search always
  // looks across the whole catalog, since three curated rows aren't worth
  // searching.
  const [tab, setTab] = useState<"suggested" | "all">("suggested");
  useEffect(() => {
    if (open) setTab("suggested");
  }, [open, mode]);
  const suggested = useMemo(
    () => suggestedModelsForMode(mode, options),
    [mode, options],
  );
  const query = search.trim().toLowerCase();
  const searching = query.length > 0;
  const reasonsById = useMemo(
    () => new Map(suggested.map((item) => [item.model.id, item.reason])),
    [suggested],
  );
  const filteredOptions = useMemo(() => {
    if (searching) {
      return options.filter((model) =>
        [
          model.name,
          model.id,
          model.description,
          model.privacy,
          ...model.traits,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query),
      );
    }
    // No suggestions in the catalog (drift, still loading): the empty tab
    // would read as "no models", so fall through to the full list.
    if (tab === "suggested" && suggested.length > 0) {
      return suggested.map((item) => item.model);
    }
    return options;
  }, [options, query, searching, suggested, tab]);
  const showReasons = !searching && tab === "suggested" && suggested.length > 0;
  const title = mode === "transcription" ? "Transcription model" : "Text model";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width={760}
      className="model-picker-dialog"
      initialFocusSelector=".model-picker-search"
    >
      <label className="model-picker-search">
        <IconMagnifyingGlass size={15} />
        <input
          className="model-picker-search-input"
          value={search}
          onChange={(event) => onSearchChange(event.currentTarget.value)}
          placeholder="Search models"
          aria-label="Search models"
        />
      </label>
      {!searching && suggested.length > 0 ? (
        <div
          className="model-picker-tabs"
          role="tablist"
          aria-label="Model groups"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "suggested"}
            onClick={() => setTab("suggested")}
          >
            Suggested
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "all"}
            onClick={() => setTab("all")}
          >
            All
          </button>
        </div>
      ) : null}
      <div className="model-picker-list" role="listbox" aria-label={title}>
        {filteredOptions.map((model) => {
          const selected = model.id === value;
          const reason = showReasons ? reasonsById.get(model.id) : undefined;
          // The text model powers June's agent, which works through tool
          // calls — a model that can't use tools (Venice's E2EE models)
          // bricks the agent, so it can't be picked. Only catalog entries
          // are judged: the synthesized placeholder for a selection the
          // catalog hasn't loaded yet has no capability data to judge by.
          const noTools =
            mode === "generation" &&
            Boolean(model.provider) &&
            !modelSupportsTools(model);
          return (
            <button
              key={model.id}
              type="button"
              className="model-picker-option"
              role="option"
              aria-selected={selected}
              aria-disabled={noTools || undefined}
              data-selected={selected}
              data-no-tools={noTools || undefined}
              title={noTools ? NO_TOOLS_MODEL_EXPLANATION : undefined}
              onClick={() => {
                if (!noTools) onSelect(model.id);
              }}
            >
              <span className="model-picker-logo" aria-hidden>
                <ProviderLogo
                  provider={model.provider}
                  id={model.id}
                  name={model.name}
                />
              </span>
              <span className="model-picker-name" title={model.description}>
                {model.name}
              </span>
              <span className="model-picker-selected" aria-hidden>
                {selected ? <IconCheckmark2Small size={14} /> : null}
              </span>
              <span className="model-picker-meta">
                {noTools ? (
                  <span className="model-picker-no-tools">No tools</span>
                ) : null}
                <ModelMeta model={model} />
              </span>
              {reason ? (
                <span className="model-picker-reason">{reason}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}

function selectedModel(options: VeniceModelDto[], value: string) {
  return (
    options.find((model) => model.id === value) ?? {
      provider: "",
      id: value,
      name: value,
      modelType: "",
      traits: [],
      capabilities: [],
    }
  );
}

function pricingLabel(model: VeniceModelDto) {
  const pricing = model.pricing;
  if (pricing && typeof pricing === "object") {
    const display = (pricing as Record<string, unknown>).display;
    if (typeof display === "string" && display.trim()) return display.trim();
    const input = priceForPath(pricing, ["input", "usd"]);
    const output = priceForPath(pricing, ["output", "usd"]);
    if (input !== undefined && output !== undefined) {
      return `$${formatUsd(input)} in / $${formatUsd(output)} out`;
    }
    const usdValues = collectUsdValues(pricing);
    if (usdValues.length === 1) return `$${formatUsd(usdValues[0])}`;
    if (usdValues.length > 1) {
      const min = Math.min(...usdValues);
      const max = Math.max(...usdValues);
      return min === max
        ? `$${formatUsd(min)}`
        : `$${formatUsd(min)}-$${formatUsd(max)}`;
    }
  }
  if (model.priceDescription?.trim()) return model.priceDescription.trim();
  if (
    model.priceUnit === "seconds" &&
    typeof model.creditsPerMillionSeconds === "number"
  ) {
    return `${formatCreditsAsUsdPerUnit(model.creditsPerMillionSeconds, 1_000_000)} per second audio`;
  }
  if (
    model.priceUnit === "tokens" &&
    typeof model.inputCreditsPerMillionTokens === "number" &&
    typeof model.outputCreditsPerMillionTokens === "number"
  ) {
    return `${formatCreditsAsUsd(model.inputCreditsPerMillionTokens)} input / ${formatCreditsAsUsd(model.outputCreditsPerMillionTokens)} output per 1M tokens`;
  }
  return undefined;
}

function priceForPath(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" ? current : undefined;
}

function collectUsdValues(value: unknown): number[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, nested]) => {
      if (key === "usd" && typeof nested === "number") return [nested];
      return collectUsdValues(nested);
    },
  );
}

function formatUsd(value: number) {
  return value >= 1 ? value.toFixed(2) : value.toFixed(4).replace(/0+$/, "0");
}

function formatCreditsAsUsd(credits: number) {
  const cents = Math.round(credits / 10);
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function formatCreditsAsUsdPerUnit(credits: number, units: number) {
  if (units <= 0) return "$0.00";
  const microUsd = Math.round((credits * 1_000) / units);
  if (microUsd >= 1_000_000) {
    const cents = Math.round(microUsd / 10_000);
    return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  }
  return `$0.${String(microUsd).padStart(6, "0").replace(/0+$/, "")}`;
}

function contextLabel(model: VeniceModelDto) {
  if (!model.contextTokens) return undefined;
  if (model.contextTokens >= 1_000_000) {
    return `${trimNumber(model.contextTokens / 1_000_000)}M context`;
  }
  if (model.contextTokens >= 1_000) {
    return `${trimNumber(model.contextTokens / 1_000)}K context`;
  }
  return `${model.contextTokens} context`;
}

function trimNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function modelOptions(models: VeniceModelDto[], selectedModel: string) {
  if (models.some((model) => model.id === selectedModel)) {
    return models;
  }
  return [
    {
      provider: "",
      id: selectedModel,
      name: selectedModel,
      modelType: "",
      traits: [],
      capabilities: [],
    },
    ...models,
  ];
}

function shortcutFromCapturePayload(
  shortcut: unknown,
  fallbackPressCount: 1 | 2,
):
  | Pick<
      DictationShortcutSetting,
      "code" | "modifiers" | "label" | "pressCount"
    >
  | undefined {
  if (!shortcut || typeof shortcut !== "object") return undefined;

  const value = shortcut as Partial<DictationShortcutSetting>;
  const modifiers = value.modifiers;
  const pressCount =
    value.pressCount === 1 || value.pressCount === 2
      ? value.pressCount
      : fallbackPressCount;
  if (
    typeof value.code !== "string" ||
    typeof value.label !== "string" ||
    !modifiers ||
    typeof modifiers.command !== "boolean" ||
    typeof modifiers.control !== "boolean" ||
    typeof modifiers.option !== "boolean" ||
    typeof modifiers.shift !== "boolean" ||
    typeof modifiers.function !== "boolean"
  ) {
    return undefined;
  }

  return {
    code: value.code,
    label: value.label,
    modifiers,
    pressCount,
  };
}

function shortcutKindLabel(kind: DictationShortcutKind) {
  return kind === "toggle" ? "Toggle dictation" : "Push to talk";
}

function shortcutForKind(
  settings: DictationSettingsDto,
  kind: DictationShortcutKind,
) {
  return kind === "toggle"
    ? settings.toggleShortcut
    : settings.pushToTalkShortcut;
}

function shortcutsMatch(
  first: DictationShortcutSetting,
  second: DictationShortcutSetting,
) {
  const keyCodesMatch =
    first.keyCode === undefined ||
    second.keyCode === undefined ||
    first.keyCode === second.keyCode;

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

function selectPopoverPlacement(
  anchor: HTMLElement | null,
  optionCount: number,
  selectedIndex: number,
): SelectPopoverPlacement {
  if (!anchor) return "align-selected";
  const rect = anchor.getBoundingClientRect();

  const viewportPadding = 12;
  const rowHeight = 28;
  const popoverPadding = 8;
  const popoverHeight = optionCount * rowHeight + popoverPadding;
  const selectedOffset = 2 + selectedIndex * rowHeight;
  const panel = anchor.closest(".main-panel");
  const panelRect = panel?.getBoundingClientRect();
  const topBound = Math.max(viewportPadding, (panelRect?.top ?? 0) + 12);
  const bottomBound = Math.min(
    window.innerHeight - viewportPadding,
    (panelRect?.bottom ?? window.innerHeight) - 12,
  );
  const alignedTop = rect.top - selectedOffset;
  const alignedBottom = alignedTop + popoverHeight;
  const belowBottom = rect.bottom + 4 + popoverHeight;
  const aboveTop = rect.top - 4 - popoverHeight;
  const spaceBelow = bottomBound - rect.bottom;
  const spaceAbove = rect.top - topBound;

  if (alignedTop >= topBound && alignedBottom <= bottomBound) {
    return "align-selected";
  }
  if (belowBottom <= bottomBound || spaceBelow >= spaceAbove) {
    return "below";
  }
  return aboveTop >= topBound ? "above" : "below";
}

function selectPopoverStyle(
  placement: SelectPopoverPlacement,
  selectedIndex: number,
): CSSProperties {
  if (placement === "below") {
    return { top: "calc(100% + 4px)" };
  }
  if (placement === "above") {
    return { bottom: "calc(100% + 4px)" };
  }
  return { top: -(2 + selectedIndex * 28) };
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
