import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconCheckmark2Small } from "central-icons-filled/IconCheckmark2Small";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { modelAvailableForMode, modelPrivacyBadge } from "../../lib/model-privacy";
import { suggestedModelsForMode } from "../../lib/suggested-models";
import type { ProviderModelMode, VeniceModelDto } from "../../lib/tauri";
import { HoverTip } from "../ui/HoverTip";
import { ModelPrivacyChip } from "../ui/ModelPrivacyChip";
import { contextLabel, pricingLabel } from "./ModelPickerDialog";
import { ProviderLogo } from "./ProviderLogo";

export type ModelPickerFlyout = { kind: "model"; id: string } | { kind: "all" } | null;

// Deliberate hover-intent delay before a row's detail card opens, so a pointer
// sweeping across rows doesn't flash the card on pass-over.
const MODEL_HOVER_INTENT_MS = 260;
const MODEL_HOVERCARD_W = 232;
const MODEL_HOVERCARD_GAP = 4;
const MODEL_HOVERCARD_VIEWPORT_MARGIN = 12;

export function ModelPickerPopover({
  mode,
  flyout,
  model,
  options,
  search,
  popoverRef,
  searchRef,
  className,
  directCatalog = false,
  title = "Model",
  ariaLabel = `Choose ${modelModeLabel(mode)} model`,
  suggestedListLabel = `Suggested ${modelModeLabel(mode)} models`,
  allModelsLabel = `All ${modelModeLabel(mode)} models`,
  onFlyoutChange,
  onSearchChange,
  onSelect,
}: {
  mode: ProviderModelMode;
  flyout: ModelPickerFlyout;
  model?: VeniceModelDto;
  options: VeniceModelDto[];
  search: string;
  popoverRef: RefObject<HTMLDivElement>;
  searchRef: RefObject<HTMLInputElement>;
  className?: string;
  directCatalog?: boolean;
  title?: string;
  ariaLabel?: string;
  suggestedListLabel?: string;
  allModelsLabel?: string;
  onFlyoutChange: (flyout: ModelPickerFlyout) => void;
  onSearchChange: (value: string) => void;
  onSelect: (modelId: string) => void;
}) {
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const hovercardRef = useRef<HTMLDivElement | null>(null);
  const [catalogHover, setCatalogHover] = useState<{
    model: VeniceModelDto;
    top: number;
    x: number;
    side: "left" | "right";
  } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const cancelHoverIntent = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);
  const hoverIntent = useCallback(
    (action: () => void) => {
      cancelHoverIntent();
      hoverTimerRef.current = window.setTimeout(action, MODEL_HOVER_INTENT_MS);
    },
    [cancelHoverIntent],
  );
  useEffect(() => cancelHoverIntent, [cancelHoverIntent]);

  const closeTimerRef = useRef<number | null>(null);
  const cancelCatalogClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const scheduleCatalogClose = useCallback(() => {
    cancelCatalogClose();
    closeTimerRef.current = window.setTimeout(() => setCatalogHover(null), MODEL_HOVER_INTENT_MS);
  }, [cancelCatalogClose]);
  useEffect(() => cancelCatalogClose, [cancelCatalogClose]);

  const [fade, setFade] = useState({ top: false, bottom: false });
  const updateFade = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const canScroll = el.scrollHeight - el.clientHeight > 1;
    const atTop = el.scrollTop <= 1;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    setFade((prev) => {
      const top = canScroll && !atTop;
      const bottom = canScroll && !atBottom;
      return prev.top === top && prev.bottom === bottom ? prev : { top, bottom };
    });
  }, []);

  useLayoutEffect(() => {
    const el = flyoutRef.current;
    if (!el) return;
    el.dataset.side = "left";
    if (flyout?.kind === "model") {
      const row = el.parentElement?.querySelector<HTMLElement>(
        '.agent-composer-model-row[data-active="true"]',
      );
      el.style.top = row ? `${row.offsetTop}px` : "";
      el.style.bottom = row ? "auto" : "";
      el.style.maxHeight = "";
    } else {
      el.style.top = "";
      el.style.bottom = "";
      const titlebar = parseFloat(getComputedStyle(el).getPropertyValue("--titlebar-h")) || 0;
      const room = el.getBoundingClientRect().bottom - titlebar - 16;
      el.style.maxHeight = `${Math.max(160, Math.min(room, 400))}px`;
    }
    if (el.getBoundingClientRect().left < 12) {
      el.dataset.side = "right";
    }
  }, [flyout]);

  useLayoutEffect(() => {
    updateFade();
  }, [directCatalog, flyout, options, search, updateFade]);

  useEffect(() => {
    setCatalogHover(null);
  }, [flyout, search]);

  // Keep the row's fixed-positioned hover card inside the viewport vertically:
  // the card is anchored to the hovered row's top, but the settings picker
  // opens downward, so a row near the viewport floor would push the card off
  // the bottom edge. Measure the real card height and pull it up so its bottom
  // stays on-screen. Horizontal side is already clamped in showCatalogHover.
  useLayoutEffect(() => {
    if (!catalogHover) return;
    const card = hovercardRef.current;
    if (!card) return;
    const height = card.getBoundingClientRect().height;
    if (height <= 0) return;
    const maxTop = window.innerHeight - height - MODEL_HOVERCARD_VIEWPORT_MARGIN;
    const clampedTop = Math.max(
      MODEL_HOVERCARD_VIEWPORT_MARGIN,
      Math.min(catalogHover.top, maxTop),
    );
    if (Math.abs(clampedTop - catalogHover.top) > 0.5) {
      setCatalogHover((prev) => (prev ? { ...prev, top: clampedTop } : prev));
    }
  }, [catalogHover]);

  const query = search.trim().toLowerCase();
  const selectable = useMemo(
    () => options.filter((option) => modelAvailableForMode(mode, option)),
    [mode, options],
  );
  const suggested = useMemo(() => suggestedModelsForMode(mode, selectable), [mode, selectable]);
  const filteredOptions = query
    ? selectable.filter((option) => modelMatchesQuery(option, query))
    : selectable;
  const detail =
    flyout?.kind === "model" ? suggested.find((item) => item.model.id === flyout.id) : undefined;

  function showCatalogHover(option: VeniceModelDto, row: HTMLElement) {
    cancelCatalogClose();
    const panel = flyoutRef.current ?? popoverRef.current;
    if (!panel) return;
    const rowRect = row.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const preferred = panel.dataset.side === "right" ? "right" : "left";
    const canOpenLeft =
      panelRect.left - MODEL_HOVERCARD_GAP - MODEL_HOVERCARD_W - MODEL_HOVERCARD_VIEWPORT_MARGIN >=
      0;
    const canOpenRight =
      panelRect.right + MODEL_HOVERCARD_GAP + MODEL_HOVERCARD_W + MODEL_HOVERCARD_VIEWPORT_MARGIN <=
      window.innerWidth;
    const side =
      preferred === "left"
        ? canOpenLeft
          ? "left"
          : canOpenRight
            ? "right"
            : null
        : canOpenRight
          ? "right"
          : canOpenLeft
            ? "left"
            : null;
    if (!side) {
      setCatalogHover(null);
      return;
    }
    setCatalogHover({
      model: option,
      top: rowRect.top,
      x:
        side === "right"
          ? panelRect.right + MODEL_HOVERCARD_GAP
          : panelRect.left - MODEL_HOVERCARD_GAP,
      side,
    });
  }

  function catalogList(label: string) {
    return (
      <>
        <label className="agent-composer-model-search">
          <IconMagnifyingGlass size={14} aria-hidden />
          <input
            ref={searchRef}
            value={search}
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            placeholder="Search models"
            aria-label="Search models"
          />
        </label>
        <div
          className="agent-composer-model-list-wrap"
          data-fade-top={fade.top || undefined}
          data-fade-bottom={fade.bottom || undefined}
        >
          <div
            ref={listRef}
            className="agent-composer-model-list"
            role="listbox"
            aria-label={label}
            onScroll={() => {
              updateFade();
              cancelHoverIntent();
              setCatalogHover(null);
            }}
          >
            {filteredOptions.length ? (
              filteredOptions.map((option) => (
                <ModelPickerOption
                  key={option.id}
                  model={option}
                  selected={option.id === model?.id}
                  onSelect={onSelect}
                  onHover={(hoverModel, row, immediate) => {
                    cancelCatalogClose();
                    if (immediate) {
                      cancelHoverIntent();
                      showCatalogHover(hoverModel, row);
                    } else {
                      hoverIntent(() => showCatalogHover(hoverModel, row));
                    }
                  }}
                />
              ))
            ) : (
              <p className="agent-composer-model-empty">No models match your search.</p>
            )}
          </div>
        </div>
      </>
    );
  }

  if (!model) return null;
  return (
    <div
      ref={popoverRef}
      className={["agent-composer-model-popover", className].filter(Boolean).join(" ")}
      role="dialog"
      aria-label={ariaLabel}
      data-direct-catalog={directCatalog || undefined}
      onMouseLeave={() => {
        cancelHoverIntent();
        if (flyout?.kind === "model") onFlyoutChange(null);
      }}
    >
      <p className="agent-composer-model-title">{title}</p>
      {directCatalog ? (
        <div className="agent-composer-model-direct" role="group" aria-label={allModelsLabel}>
          {catalogList(allModelsLabel)}
        </div>
      ) : (
        <>
          <div className="agent-composer-model-menu" role="listbox" aria-label={suggestedListLabel}>
            {suggested.length ? (
              suggested.map(({ model: option }) => (
                <button
                  key={option.id}
                  type="button"
                  className="agent-composer-model-row"
                  role="option"
                  aria-selected={option.id === model.id}
                  data-active={(flyout?.kind === "model" && flyout.id === option.id) || undefined}
                  onMouseEnter={() =>
                    hoverIntent(() => onFlyoutChange({ kind: "model", id: option.id }))
                  }
                  onFocus={() => {
                    cancelHoverIntent();
                    onFlyoutChange({ kind: "model", id: option.id });
                  }}
                  onClick={() => onSelect(option.id)}
                >
                  <ModelPickerOptionText model={option} />
                  {option.id === model.id ? (
                    <IconCheckmark2Small
                      size={14}
                      aria-hidden
                      className="agent-composer-model-row-check"
                    />
                  ) : null}
                </button>
              ))
            ) : (
              <p className="agent-composer-model-empty">Loading suggested models.</p>
            )}
          </div>
          <button
            type="button"
            className="agent-composer-model-row agent-composer-model-all"
            aria-haspopup="true"
            aria-expanded={flyout?.kind === "all"}
            data-active={flyout?.kind === "all" || undefined}
            onMouseEnter={() => hoverIntent(() => onFlyoutChange({ kind: "all" }))}
            onFocus={() => {
              cancelHoverIntent();
              onFlyoutChange({ kind: "all" });
            }}
            onClick={() => {
              cancelHoverIntent();
              onFlyoutChange({ kind: "all" });
              searchRef.current?.focus();
            }}
          >
            <span className="agent-composer-model-row-name">All models</span>
            <IconChevronRightSmall
              size={12}
              aria-hidden
              className="agent-composer-model-row-chevron"
            />
          </button>
        </>
      )}
      {detail ? (
        <div ref={flyoutRef} className="agent-composer-model-flyout agent-composer-model-detail">
          <div className="agent-composer-model-surface">
            <ModelPickerCardContent model={detail.model} />
          </div>
        </div>
      ) : flyout?.kind === "all" ? (
        <div
          ref={flyoutRef}
          className="agent-composer-model-flyout agent-composer-model-all-panel"
          role="group"
          aria-label={allModelsLabel}
          onMouseLeave={() => {
            cancelHoverIntent();
            scheduleCatalogClose();
          }}
        >
          <div className="agent-composer-model-surface">{catalogList(allModelsLabel)}</div>
        </div>
      ) : null}
      {(flyout?.kind === "all" || directCatalog) && catalogHover ? (
        <div
          ref={hovercardRef}
          className="agent-composer-model-hovercard agent-composer-model-detail"
          data-side={catalogHover.side}
          onMouseEnter={cancelCatalogClose}
          onMouseLeave={scheduleCatalogClose}
          style={
            catalogHover.side === "right"
              ? { top: catalogHover.top, left: catalogHover.x }
              : {
                  top: catalogHover.top,
                  right: window.innerWidth - catalogHover.x,
                }
          }
        >
          <div className="agent-composer-model-surface">
            <ModelPickerCardContent model={catalogHover.model} withDescription />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ModelPickerCardContent({
  model,
  withDescription,
}: {
  model: VeniceModelDto;
  withDescription?: boolean;
}) {
  const badge = modelPrivacyBadge(model);
  const values = [pricingLabel(model), contextLabel(model)].filter(Boolean).join(" · ");
  return (
    <>
      <p className="agent-composer-model-detail-name">
        <span>{model.name}</span>
        {badge ? (
          <ModelPrivacyChip
            badge={badge}
            withTip={false}
            label={badge.label.replace(" mode", "")}
          />
        ) : null}
      </p>
      {values ? <p className="agent-composer-model-detail-values">{values}</p> : null}
      {withDescription && model.description ? (
        <ModelPickerDescription text={model.description} />
      ) : null}
    </>
  );
}

function ModelPickerDescription({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setClamped(el.scrollHeight - el.clientHeight > 1);
  }, [text]);
  const body = (
    <span ref={ref} className="agent-composer-model-detail-desc">
      {text}
    </span>
  );
  return clamped ? (
    <HoverTip tip={text} className="agent-composer-model-detail-desc-tip">
      {body}
    </HoverTip>
  ) : (
    body
  );
}

function ModelPickerOption({
  model,
  selected,
  onSelect,
  onHover,
}: {
  model: VeniceModelDto;
  selected: boolean;
  onSelect: (modelId: string) => void;
  onHover: (model: VeniceModelDto, row: HTMLElement, immediate: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="agent-composer-model-row"
      role="option"
      aria-selected={selected}
      onMouseEnter={(event) => onHover(model, event.currentTarget, false)}
      onFocus={(event) => onHover(model, event.currentTarget, true)}
      onClick={() => onSelect(model.id)}
    >
      <ModelPickerOptionText model={model} />
      {selected ? (
        <IconCheckmark2Small size={14} aria-hidden className="agent-composer-model-row-check" />
      ) : null}
    </button>
  );
}

function ModelPickerOptionText({ model }: { model: VeniceModelDto }) {
  return (
    <>
      <span className="agent-composer-model-row-logo" aria-hidden>
        <ProviderLogo provider={model.provider} id={model.id} name={model.name} />
      </span>
      <span className="agent-composer-model-row-copy">
        <span className="agent-composer-model-row-name">{model.name}</span>
      </span>
    </>
  );
}

function modelMatchesQuery(model: VeniceModelDto, query: string) {
  return [model.name, model.id, model.description, model.privacy, ...model.traits]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function modelModeLabel(mode: ProviderModelMode) {
  if (mode === "generation") return "text";
  return mode;
}
