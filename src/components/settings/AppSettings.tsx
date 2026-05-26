import { listen } from "@tauri-apps/api/event";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconSettingsGear1 } from "central-icons/IconSettingsGear1";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  dictationHelperCommand,
  dictationSettings,
  listVeniceModels,
  openPrivacySettings,
  providerModelSettings,
  setDictationMicrophone,
  setVeniceModel,
} from "../../lib/tauri";
import type {
  DictationHelperEvent,
  DictationMicrophoneDeviceDto,
  DictationSettingsDto,
  ProviderModelMode,
  ProviderModelSettingsDto,
  RecordingSourceMode,
  RecordingSourceReadinessDto,
  VeniceModelDto,
} from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";
import { Switch } from "../ui/Switch";

const DEFAULT_SETTINGS: DictationSettingsDto = {
  shortcut: {
    code: "Space",
    label: "Fn+Space",
    modifiers: {
      command: false,
      control: false,
      option: false,
      shift: false,
      function: true,
    },
  },
  microphone: {},
  postProcessing: { enabled: false },
};

const DEFAULT_PROVIDER_MODELS: ProviderModelSettingsDto = {
  transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
  generationModel: "zai-org-glm-5",
};

type AppSettingsProps = {
  sourceMode: RecordingSourceMode;
  sourceReadiness?: RecordingSourceReadinessDto;
  checkingSourceReadiness: boolean;
  onSourceModeChange: (mode: RecordingSourceMode) => void;
};

type DictationPermissionStatus = {
  microphone?: string;
  accessibility?: string;
};

export function AppSettings({
  sourceMode,
  sourceReadiness,
  checkingSourceReadiness,
  onSourceModeChange,
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
  const [permissions, setPermissions] = useState<DictationPermissionStatus>({});
  const [status, setStatus] = useState<string>();
  const [micOpen, setMicOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<ProviderModelMode>();
  const [modelSearch, setModelSearch] = useState("");
  const micWrapRef = useRef<HTMLDivElement>(null);
  const systemOn = sourceMode === "microphonePlusSystem";
  const systemReadiness = sourceReadiness?.sources.find(
    (source) => source.source === "system",
  );
  const systemBlocked = !!(systemReadiness && !systemReadiness.ready);

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
        await requestPermissionStatus();
        await Promise.all([
          requestVeniceModels("transcription"),
          requestVeniceModels("generation"),
        ]);
      } catch (error) {
        if (!cancelled) setStatus(messageFromError(error));
      }
    }

    void listen<string>("dictation-event", (event) => {
      const helperEvent = parseDictationEvent(event.payload);
      if (helperEvent) handleHelperEvent(helperEvent);
    }).then((cleanup) => {
      unlisten = cleanup;
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

  async function requestMicrophones() {
    try {
      await dictationHelperCommand({ type: "list_microphones" });
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function requestPermissionStatus() {
    try {
      await dictationHelperCommand({ type: "get_permission_status" });
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
      return;
    }
    if (
      helperEvent.type === "permission_status" ||
      helperEvent.type === "dictation_diagnostics"
    ) {
      setPermissions({
        microphone: stringPayloadValue(helperEvent.payload?.microphone),
        accessibility: stringPayloadValue(helperEvent.payload?.accessibility),
      });
      return;
    }
    if (helperEvent.type === "error") {
      setStatus(helperEvent.payload?.message ?? "Settings helper failed.");
    }
  }

  async function selectMicrophone(id?: string, name?: string) {
    try {
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

  async function selectVeniceModel(mode: ProviderModelMode, modelId: string) {
    try {
      const next = await setVeniceModel(mode, modelId);
      setProviderSettings(next);
      setStatus(
        mode === "transcription"
          ? "Transcription model updated."
          : "Note generation model updated.",
      );
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function openPermissionPane(
    pane: "microphone" | "accessibility",
    label: string,
  ) {
    try {
      await openPrivacySettings(pane);
      setStatus(`Opened ${label} settings.`);
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  const microphoneName = settings.microphone.name ?? "Auto-detect";
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

  return (
    <div className="settings-page">
      <header className="settings-header">
        <h1 className="settings-title">Settings</h1>
        <p className="settings-description">
          Manage audio and permissions used by notes and dictation.
        </p>
        {status ? <p className="settings-status">{status}</p> : null}
      </header>

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
                  Input device used for dictation.
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
                  <ul
                    className="select-popover"
                    role="listbox"
                    style={{ top: -(4 + selectedMicrophoneIndex * 28) }}
                  >
                    {microphoneOptions.map((option) => {
                      const selected =
                        (option.id ?? "") === (settings.microphone.id ?? "");
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

            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Note recording audio</h3>
                <p className="settings-row-description">
                  Include system audio when creating notes.
                  {systemBlocked ? (
                    <span className="settings-row-inline-error">
                      {systemReadiness?.message ??
                        "System audio is unavailable."}
                    </span>
                  ) : null}
                </p>
              </div>
              <div className="settings-row-control">
                <Switch
                  checked={systemOn}
                  disabled={
                    checkingSourceReadiness || (systemBlocked && !systemOn)
                  }
                  aria-label="Capture system audio for notes"
                  onCheckedChange={(next) =>
                    onSourceModeChange(
                      next ? "microphonePlusSystem" : "microphoneOnly",
                    )
                  }
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <ModelPickerDialog
        open={!!pickerMode}
        mode={pickerMode ?? "transcription"}
        value={pickerValue}
        options={pickerOptions}
        search={modelSearch}
        onSearchChange={setModelSearch}
        onClose={() => setPickerMode(undefined)}
        onRefresh={() =>
          pickerMode ? void requestVeniceModels(pickerMode) : undefined
        }
        onSelect={(modelId) => {
          if (!pickerMode) return;
          void selectVeniceModel(pickerMode, modelId);
          setPickerMode(undefined);
        }}
      />

      <section
        className="settings-group"
        aria-labelledby="app-permissions-heading"
      >
        <div className="settings-group-header">
          <h2 id="app-permissions-heading" className="settings-group-heading">
            Permissions
          </h2>
          <button
            type="button"
            className="btn btn-ghost settings-group-action"
            onClick={() => void requestPermissionStatus()}
          >
            <IconArrowRotateClockwise size={14} />
            Check again
          </button>
        </div>
        <div className="settings-card">
          <div className="settings-rows">
            <PermissionRow
              title="Microphone"
              description="Required to capture dictation and note audio."
              status={permissions.microphone}
              onOpenSettings={() =>
                void openPermissionPane("microphone", "Microphone")
              }
            />
            <PermissionRow
              title="Accessibility"
              description="Required to paste dictated text into the active app."
              status={permissions.accessibility}
              onOpenSettings={() =>
                void openPermissionPane("accessibility", "Accessibility")
              }
            />
          </div>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="models-heading">
        <div className="settings-group-header">
          <h2 id="models-heading" className="settings-group-heading">
            Venice models
          </h2>
          <button
            type="button"
            className="btn btn-ghost settings-group-action"
            onClick={() =>
              void Promise.all([
                requestVeniceModels("transcription"),
                requestVeniceModels("generation"),
              ])
            }
          >
            <IconArrowRotateClockwise size={14} />
            Refresh
          </button>
        </div>
        <div className="settings-card">
          <div className="settings-rows">
            <ModelRow
              title="Transcription"
              description="Used for note recordings and dictation."
              value={providerSettings.transcriptionModel}
              options={transcriptionOptions}
              onOpen={() => openModelPicker("transcription")}
            />
            <ModelRow
              title="Note generation"
              description="Used to write generated notes from transcripts."
              value={providerSettings.generationModel}
              options={generationOptions}
              onOpen={() => openModelPicker("generation")}
            />
          </div>
        </div>
      </section>
    </div>
  );
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
          <span className="model-summary-main">
            <span className="model-summary-name">{model.name}</span>
            <span className="model-summary-id">{model.id}</span>
          </span>
          <span className="model-summary-meta">
            <ModelBadges model={model} compact />
            <span className="model-summary-price">{pricingLabel(model)}</span>
          </span>
          <IconChevronDownSmall size={14} />
        </button>
      </div>
    </div>
  );
}

function ModelPickerDialog({
  open,
  mode,
  value,
  options,
  search,
  onSearchChange,
  onClose,
  onRefresh,
  onSelect,
}: {
  open: boolean;
  mode: ProviderModelMode;
  value: string;
  options: VeniceModelDto[];
  search: string;
  onSearchChange: (value: string) => void;
  onClose: () => void;
  onRefresh: () => void;
  onSelect: (modelId: string) => void;
}) {
  const filteredOptions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return options;
    return options.filter((model) =>
      [model.name, model.id, model.description, model.privacy, ...model.traits]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [options, search]);
  const title =
    mode === "transcription" ? "Transcription model" : "Note generation model";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width={760}
      className="model-picker-dialog"
      initialFocusSelector=".model-picker-search"
      footer={
        <button type="button" className="btn btn-ghost" onClick={onRefresh}>
          <IconArrowRotateClockwise size={14} />
          Refresh
        </button>
      }
    >
      <div className="model-picker-toolbar">
        <input
          className="model-picker-search"
          value={search}
          onChange={(event) => onSearchChange(event.currentTarget.value)}
          placeholder="Search models"
          aria-label="Search models"
        />
      </div>
      <div className="model-picker-list" role="listbox" aria-label={title}>
        {filteredOptions.map((model) => {
          const selected = model.id === value;
          return (
            <button
              key={model.id}
              type="button"
              className="model-picker-option"
              role="option"
              aria-selected={selected}
              data-selected={selected}
              onClick={() => onSelect(model.id)}
            >
              <span className="model-picker-option-header">
                <span className="model-picker-title-group">
                  <span className="model-picker-name">{model.name}</span>
                  <span className="model-picker-id">{model.id}</span>
                </span>
                <span className="model-picker-selected" aria-hidden>
                  {selected ? <IconCheckmark1Small size={15} /> : null}
                </span>
              </span>
              {model.description ? (
                <span className="model-picker-description">
                  {model.description}
                </span>
              ) : null}
              {(() => {
                const context = contextLabel(model);
                return (
                  <span className="model-picker-facts">
                    <span>{pricingLabel(model)}</span>
                    {context ? <span>{context}</span> : null}
                  </span>
                );
              })()}
              <ModelBadges model={model} />
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
      id: value,
      name: value,
      modelType: "",
      traits: [],
      capabilities: [],
    }
  );
}

function ModelBadges({
  model,
  compact = false,
}: {
  model: VeniceModelDto;
  compact?: boolean;
}) {
  const badges = modelBadges(model);
  const visible = compact ? badges.slice(0, 2) : badges.slice(0, 6);
  if (visible.length === 0) {
    return compact ? null : (
      <span className="model-badge" data-kind="neutral">
        Standard
      </span>
    );
  }
  return (
    <span className="model-badges">
      {visible.map((badge) => (
        <span
          key={`${badge.kind}-${badge.label}`}
          className="model-badge"
          data-kind={badge.kind}
        >
          {badge.label}
        </span>
      ))}
    </span>
  );
}

function modelBadges(model: VeniceModelDto) {
  const badges: Array<{ label: string; kind: string }> = [];
  if (model.privacy) {
    badges.push({
      label: privacyLabel(model.privacy),
      kind: model.privacy.toLowerCase().includes("private")
        ? "private"
        : "privacy",
    });
  }
  for (const trait of model.traits) {
    const normalized = trait.toLowerCase();
    if (normalized.includes("uncensored")) {
      badges.push({ label: "Uncensored", kind: "uncensored" });
    } else if (
      normalized.includes("anonymous") ||
      normalized.includes("anonymized")
    ) {
      badges.push({ label: "Anon", kind: "anon" });
    }
  }
  return uniqueBadges(badges);
}

function uniqueBadges(badges: Array<{ label: string; kind: string }>) {
  const seen = new Set<string>();
  return badges.filter((badge) => {
    const key = `${badge.kind}:${badge.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function privacyLabel(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "private") return "Private";
  if (normalized.includes("anonymous") || normalized.includes("anonymized")) {
    return "Anon";
  }
  return titleCase(value);
}

function pricingLabel(model: VeniceModelDto) {
  const pricing = model.pricing;
  if (!pricing || typeof pricing !== "object") return "Pricing unavailable";
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
  return "Pricing unavailable";
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

function titleCase(value: string) {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function modelOptions(models: VeniceModelDto[], selectedModel: string) {
  if (models.some((model) => model.id === selectedModel)) {
    return models;
  }
  return [
    {
      id: selectedModel,
      name: selectedModel,
      modelType: "",
      traits: [],
      capabilities: [],
    },
    ...models,
  ];
}

function PermissionRow({
  title,
  description,
  status,
  onOpenSettings,
}: {
  title: string;
  description: string;
  status?: string;
  onOpenSettings: () => void;
}) {
  const display = permissionDisplay(status);
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <h3 className="settings-row-title">{title}</h3>
        <p className="settings-row-description">{description}</p>
      </div>
      <div className="settings-row-control settings-permission-control">
        <span className="permission-pill" data-state={display.state}>
          {display.label}
        </span>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onOpenSettings}
        >
          <IconSettingsGear1 size={14} />
          Open
        </button>
      </div>
    </div>
  );
}

function parseDictationEvent(
  payload: unknown,
): DictationHelperEvent | undefined {
  try {
    if (typeof payload === "string") {
      return JSON.parse(payload) as DictationHelperEvent;
    }
    if (payload && typeof payload === "object") {
      return payload as DictationHelperEvent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function stringPayloadValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function permissionDisplay(status?: string) {
  switch (status) {
    case "authorized":
    case "granted":
      return { label: "Allowed", state: "allowed" };
    case "denied":
      return { label: "Needs permission", state: "blocked" };
    case "restricted":
      return { label: "Restricted", state: "blocked" };
    case "not_determined":
      return { label: "Not requested", state: "waiting" };
    default:
      return { label: "Checking", state: "waiting" };
  }
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
