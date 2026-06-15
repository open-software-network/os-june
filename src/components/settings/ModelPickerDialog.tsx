import { IconAnonymous } from "central-icons/IconAnonymous";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconFire1 } from "central-icons/IconFire1";
import { IconGhost2 } from "central-icons/IconGhost2";
import { IconLock } from "central-icons/IconLock";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  modelPrivacyBadge,
  modelPrivacyFlags,
  modelSupportsTools,
} from "../../lib/model-privacy";
import { suggestedModelsForMode } from "../../lib/suggested-models";
import type { ProviderModelMode, VeniceModelDto } from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";
import { HoverTip } from "../ui/HoverTip";
import { ProviderLogo } from "./ProviderLogo";

// Model catalog UI shared between Settings (the Models tab rows) and the
// agent workspace (the session bar's model pill): the picker dialog itself
// plus the meta line and option-list helpers it renders with. Moved out of
// AppSettings.tsx verbatim so the workspace can open the picker without
// pulling in the whole settings surface.

export function ModelMeta({ model }: { model: VeniceModelDto }) {
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
        aria-label={`${privacyBadge.label}: ${privacyBadge.description}`}
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

const NO_TOOLS_MODEL_EXPLANATION =
  "This model can't use tools, so June's agent can't work with it. Pick a tool-capable model to use June.";

export function ModelPickerDialog({
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
  const [localModelId, setLocalModelId] = useState("");
  useEffect(() => {
    if (open) {
      setTab("suggested");
      setLocalModelId("");
    }
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
  const localModelIdValue = localModelId.trim();
  const localModelLabel =
    mode === "transcription" ? "Local ASR model ID" : "Local text model ID";
  const localModelPlaceholder =
    mode === "transcription" ? "local-whisper" : "ollama/qwen3:30b";
  const localModelDescription =
    mode === "transcription"
      ? "Enter the model ID exposed by your local Scribe API. It will be used for recordings and dictation."
      : "Enter the model ID exposed by your local Scribe API. Local text models should support tool calls for the agent.";

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
      <form
        className="model-picker-local"
        onSubmit={(event) => {
          event.preventDefault();
          if (localModelIdValue) onSelect(localModelIdValue);
        }}
      >
        <div className="model-picker-local-copy">
          <p className="model-picker-local-title">Use local model</p>
          <p className="model-picker-local-description">
            {localModelDescription}
          </p>
        </div>
        <div className="model-picker-local-controls">
          <input
            className="model-picker-local-input"
            value={localModelId}
            onChange={(event) => setLocalModelId(event.currentTarget.value)}
            placeholder={localModelPlaceholder}
            aria-label={localModelLabel}
          />
          <button
            type="submit"
            className="btn btn-secondary model-picker-local-submit"
            disabled={!localModelIdValue}
          >
            <IconPlusMedium size={14} aria-hidden />
            Use
          </button>
        </div>
      </form>
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

export function selectedModel(
  options: VeniceModelDto[],
  value: string,
  mode?: ProviderModelMode,
) {
  return options.find((model) => model.id === value) ?? localModel(value, mode);
}

export function pricingLabel(model: VeniceModelDto) {
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

export function contextLabel(model: VeniceModelDto) {
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

export function modelOptions(
  models: VeniceModelDto[],
  selectedModel: string,
  mode?: ProviderModelMode,
) {
  const modelId = selectedModel.trim();
  if (!modelId || models.some((model) => model.id === modelId)) {
    return models;
  }
  return [localModel(modelId, mode), ...models];
}

function localModel(modelId: string, mode?: ProviderModelMode): VeniceModelDto {
  const trimmed = modelId.trim();
  const modelType =
    mode === "transcription" ? "asr" : mode === "generation" ? "text" : "";
  return {
    provider: "local",
    id: trimmed,
    name: trimmed,
    modelType,
    description:
      mode === "transcription"
        ? "Custom speech-to-text model."
        : "Custom text model.",
    priceUnit: "local",
    priceDescription: "Custom model",
    traits: ["custom"],
    capabilities: mode === "generation" ? ["supportsFunctionCalling"] : [],
  };
}
