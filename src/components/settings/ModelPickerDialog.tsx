import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconFire1 } from "central-icons/IconFire1";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  modelAvailableForMode,
  modelPrivacyBadge,
  modelPrivacyFlags,
} from "../../lib/model-privacy";
import { suggestedModelsForMode } from "../../lib/suggested-models";
import type { ProviderModelMode, VeniceModelDto } from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";
import { HoverTip } from "../ui/HoverTip";
import { ModelPrivacyChip } from "../ui/ModelPrivacyChip";
import { ProviderLogo } from "./ProviderLogo";

const AUTO_MODEL_ID = "open-software/auto";

type ModelPickerEntry = {
  key: string;
  model: VeniceModelDto;
  reason?: string;
  costQuality?: number;
};

function withJuneModelName(model: VeniceModelDto): VeniceModelDto {
  return model.id === AUTO_MODEL_ID && model.name !== "Auto" ? { ...model, name: "Auto" } : model;
}

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
  if ((model.modelType === "image" || model.modelType === "video") && model.description) {
    items.push(<span>{model.description}</span>);
  }
  if (privacyBadge) {
    const imagePrivacyLabel =
      model.modelType === "image"
        ? privacyBadge.mode === "private"
          ? "Private"
          : privacyBadge.mode === "anonymous"
            ? "Anonymized"
            : undefined
        : undefined;
    items.push(<ModelPrivacyChip badge={privacyBadge} label={imagePrivacyLabel} />);
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

export function ModelPickerDialog({
  open,
  mode,
  value,
  options,
  costQuality,
  search,
  onSearchChange,
  onClose,
  onSelect,
}: {
  open: boolean;
  mode: ProviderModelMode;
  value: string;
  options: VeniceModelDto[];
  costQuality?: number;
  search: string;
  onSearchChange: (value: string) => void;
  onClose: () => void;
  onSelect: (modelId: string, costQuality?: number) => void;
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
  const availableOptions = useMemo(
    () => options.filter((model) => modelAvailableForMode(mode, model)),
    [mode, options],
  );
  const suggested = useMemo(
    () => suggestedModelsForMode(mode, availableOptions),
    [mode, availableOptions],
  );
  const query = search.trim().toLowerCase();
  const searching = query.length > 0;
  const filteredOptions = useMemo<ModelPickerEntry[]>(() => {
    if (searching) {
      return availableOptions
        .filter((model) =>
          [model.name, model.id, model.description, model.privacy, ...model.traits]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(query),
        )
        .map((model) => ({ key: model.id, model }));
    }
    // No suggestions in the catalog (drift, still loading): the empty tab
    // would read as "no models", so fall through to the full list.
    if (tab === "suggested" && suggested.length > 0) {
      return suggested;
    }
    return availableOptions.map((model) => ({ key: model.id, model }));
  }, [availableOptions, query, searching, suggested, tab]);
  const showReasons = !searching && tab === "suggested" && suggested.length > 0;
  const title =
    mode === "transcription"
      ? "Transcription model"
      : mode === "image"
        ? "Image model"
        : mode === "video"
          ? "Video model"
          : "Text model";

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
        <div className="model-picker-tabs" role="tablist" aria-label="Model groups">
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
        {filteredOptions.map((item) => {
          const { model } = item;
          const presetCostQuality = item.costQuality;
          const selected =
            model.id === value &&
            (presetCostQuality === undefined || presetCostQuality === costQuality);
          const reason = showReasons ? item.reason : undefined;
          // A local (bring-your-own) endpoint is selectable, but its tool
          // support can't be verified from here, so it carries a non-blocking
          // caveat rather than the disabling no-tools treatment.
          const localCaveat = mode === "generation" && model.provider === "local";
          return (
            <button
              key={item.key}
              type="button"
              className="model-picker-option"
              role="option"
              aria-selected={selected}
              data-selected={selected}
              onClick={() => onSelect(model.id, presetCostQuality)}
            >
              <span className="model-picker-logo" aria-hidden>
                <ProviderLogo provider={model.provider} id={model.id} name={model.name} />
              </span>
              <span className="model-picker-name" title={model.description}>
                {model.name}
              </span>
              <span className="model-picker-selected" aria-hidden>
                {selected ? <IconCheckmark2Small size={14} /> : null}
              </span>
              <span className="model-picker-meta">
                {localCaveat ? (
                  <HoverTip
                    tip="Tool support depends on your local model."
                    className="model-picker-tools-caveat"
                    compact
                    width={220}
                    tabIndex={0}
                    aria-label="Tools not verified. Tool support depends on your local model."
                    onClick={(event) => event.stopPropagation()}
                  >
                    Tools not verified
                  </HoverTip>
                ) : null}
                <ModelMeta model={model} />
              </span>
              {reason ? <span className="model-picker-reason">{reason}</span> : null}
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}

export function selectedModel(options: VeniceModelDto[], value: string) {
  return withJuneModelName(
    options.find((model) => model.id === value) ?? {
      provider: "",
      id: value,
      name: value,
      modelType: "",
      traits: [],
      capabilities: [],
    },
  );
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
      return min === max ? `$${formatUsd(min)}` : `$${formatUsd(min)}-$${formatUsd(max)}`;
    }
  }
  if (model.priceDescription?.trim()) return model.priceDescription.trim();
  if (model.priceUnit === "seconds" && typeof model.creditsPerMillionSeconds === "number") {
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
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
    if (key === "usd" && typeof nested === "number") return [nested];
    return collectUsdValues(nested);
  });
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

// The hover card's spec list: the pricing/context facts split into label/value
// pairs so the card renders a compact spec table instead of a prose sentence.
// Falls back to a single "Pricing" row when there is no clean input/output
// credit split.
export function modelSpecEntries(model: VeniceModelDto): { label: string; value: string }[] {
  // Auto is a routing preference, not a concrete model. Its eventual model,
  // price, and context window vary by request, so fixed catalog specs would be
  // misleading even when the compatibility catalog provides placeholders.
  if (model.id === "open-software/auto") return [];

  const entries: { label: string; value: string }[] = [];
  // Use June's billed credit price (with margin) for the input/output split.
  // The raw `pricing.*.usd` on the DTO is upstream provider metadata the backend
  // keeps for reference only — the user-facing price must come from the credit
  // price (see june-api handlers/models.rs), so it is never shown as the price
  // here. Anything without the credit split defers to `pricingLabel`, which
  // resolves the price the same way the rest of the app does.
  if (
    model.priceUnit === "tokens" &&
    typeof model.inputCreditsPerMillionTokens === "number" &&
    typeof model.outputCreditsPerMillionTokens === "number"
  ) {
    entries.push({
      label: "Input",
      value: `${formatCreditsAsUsd(model.inputCreditsPerMillionTokens)} /1M`,
    });
    entries.push({
      label: "Output",
      value: `${formatCreditsAsUsd(model.outputCreditsPerMillionTokens)} /1M`,
    });
  } else {
    const price = pricingLabel(model);
    if (price) entries.push({ label: "Pricing", value: price });
  }
  if (model.contextTokens) {
    const context =
      model.contextTokens >= 1_000_000
        ? `${trimNumber(model.contextTokens / 1_000_000)}M tokens`
        : model.contextTokens >= 1_000
          ? `${trimNumber(model.contextTokens / 1_000)}K tokens`
          : `${model.contextTokens} tokens`;
    entries.push({ label: "Context", value: context });
  }
  return entries;
}

export function modelOptions(models: VeniceModelDto[], selectedModel: string) {
  const modelId = selectedModel.trim();
  const namedModels = models.map(withJuneModelName);
  if (!modelId || namedModels.some((model) => model.id === modelId)) {
    return namedModels;
  }
  return [
    withJuneModelName({
      provider: "",
      id: modelId,
      name: modelId,
      modelType: "",
      traits: [],
      capabilities: [],
    }),
    ...namedModels,
  ];
}
