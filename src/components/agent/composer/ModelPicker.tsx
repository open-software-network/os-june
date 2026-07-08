import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconShieldCrossed } from "central-icons/IconShieldCrossed";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import {
  modelPrivacyBadge,
  modelSupportsTools,
  type ModelPrivacyBadge,
} from "../../../lib/model-privacy";
import { suggestedModelsForMode } from "../../../lib/suggested-models";
import type { VeniceModelDto } from "../../../lib/tauri";
import { HoverTip } from "../../ui/HoverTip";
import { ModelPrivacyChip } from "../../ui/ModelPrivacyChip";
import { contextLabel, pricingLabel } from "../../settings/ModelPickerDialog";

/** The composer's model picker: the trigger pill and its two-layer popover
 * (suggested rows + an "All models" flyout with search). Extracted from
 * AgentWorkspace so compact chat surfaces (the note chat panel) offer the
 * exact same model selection. */

export function ComposerModelPicker({
  open,
  model,
  readOnly = false,
  triggerRef,
  onToggleOpen,
}: {
  open: boolean;
  model?: VeniceModelDto;
  readOnly?: boolean;
  triggerRef: RefObject<HTMLButtonElement>;
  onToggleOpen: () => void;
}) {
  if (!model) return null;
  if (readOnly) {
    return (
      <div className="agent-composer-model" data-readonly="true">
        <span className="agent-composer-model-label">
          <span>{model.name}</span>
        </span>
      </div>
    );
  }
  return (
    <div className="agent-composer-model" data-open={open || undefined}>
      <button
        ref={triggerRef}
        type="button"
        className="agent-composer-model-trigger"
        aria-label={`Model: ${model.name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggleOpen}
      >
        <span>{model.name}</span>
        <IconChevronDownSmall size={12} aria-hidden />
      </button>
    </div>
  );
}

// The composer model popover is two-layered, menu-style: the root layer
// lists the curated suggested models as plain rows, and a flyout panel
// opens beside it — hover details for a suggested row, or the searchable
// full catalog behind the "All models" row.
export type ComposerModelFlyout = { kind: "model"; id: string } | { kind: "all" } | null;

// Hover-intent delay before a hover opens a flyout or card — a pointer
// sweeping across rows (or rows scrolling under a resting pointer) should
// not flash panels open. Click and keyboard focus stay immediate.
const MODEL_HOVER_INTENT_MS = 150;
const MODEL_HOVERCARD_W = 220;
const MODEL_HOVERCARD_GAP = 4;
const MODEL_HOVERCARD_VIEWPORT_MARGIN = 12;

export function ComposerModelPopover({
  flyout,
  model,
  options,
  search,
  popoverRef,
  searchRef,
  onFlyoutChange,
  onSearchChange,
  onSelect,
}: {
  flyout: ComposerModelFlyout;
  model?: VeniceModelDto;
  options: VeniceModelDto[];
  search: string;
  popoverRef: RefObject<HTMLDivElement>;
  searchRef: RefObject<HTMLInputElement>;
  onFlyoutChange: (flyout: ComposerModelFlyout) => void;
  onSearchChange: (value: string) => void;
  onSelect: (modelId: string) => void;
}) {
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Styled hover card for catalog rows (replaces the native title tooltip):
  // fixed-positioned next to the hovered row, on the panel's outer side.
  const [catalogHover, setCatalogHover] = useState<{
    model: VeniceModelDto;
    top: number;
    x: number;
    side: "left" | "right";
  } | null>(null);
  // One shared timer debounces every hover trigger in the popover.
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
  // The catalog hover card is interactive (its description carries its own
  // hover tip for the full, untruncated text), so it cannot vanish the instant
  // the pointer leaves a row — it has to survive the trip across the gap onto
  // the card. A short close debounce bridges that gap; entering the card or a
  // fresh row cancels it.
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
  // Position-aware scroll fades on the catalog list, same treatment as the
  // artifact panel body: only when it overflows, only on edges with hidden
  // content.
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

  // The flyout always opens on the composer side (left of the menu), where
  // there is reliably room — flipping with the window edge made the card
  // jump sides between otherwise-identical hovers. The right side is only a
  // fallback for the degenerate case of the menu hugging the left edge.
  //
  // The hover detail card pins to the hovered row, submenu-style, so it
  // shows up next to the pointer. The all-models panel stays anchored to
  // the menu's bottom edge and grows upward, so its height is capped to the
  // room above — clearing the titlebar strip, which would otherwise cover
  // the search field — and to a fixed ceiling so it doesn't tower on tall
  // windows.
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

  // Re-measure the fades whenever the list's content or cap changes: panel
  // open (after the max-height effect above), and every search keystroke.
  useLayoutEffect(() => {
    updateFade();
  }, [flyout, search, options, updateFade]);

  // Row positions shift under the pointer on filter/reflow, so a lingering
  // card would point at the wrong row.
  useEffect(() => {
    setCatalogHover(null);
  }, [flyout, search]);

  if (!model) return null;
  const suggested = suggestedModelsForMode("generation", options);
  const query = search.trim().toLowerCase();
  // June's agent needs tool calls, so models without tool support can never
  // be picked — leave them out of the quick-switch list entirely instead of
  // showing dead rows. (Settings still lists them, greyed, for context.)
  const selectable = options.filter((option) => !option.provider || modelSupportsTools(option));
  const filteredOptions = query
    ? selectable.filter((option) => modelMatchesQuery(option, query))
    : selectable;
  const detail =
    flyout?.kind === "model" ? suggested.find((item) => item.model.id === flyout.id) : undefined;

  function showCatalogHover(option: VeniceModelDto, row: HTMLElement) {
    cancelCatalogClose();
    const panel = flyoutRef.current;
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

  return (
    <div
      ref={popoverRef}
      className="agent-composer-model-popover"
      role="dialog"
      aria-label="Choose text model"
      onMouseLeave={() => {
        // Hover details follow the pointer out; the all-models panel stays
        // pinned so a search in progress doesn't vanish mid-keystroke.
        cancelHoverIntent();
        if (flyout?.kind === "model") onFlyoutChange(null);
      }}
    >
      <p className="agent-composer-model-title">Model</p>
      <div className="agent-composer-model-menu" role="listbox" aria-label="Suggested text models">
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
              <span className="agent-composer-model-row-name">{option.name}</span>
              {option.id === model.id ? (
                <IconCheckmark1Small
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
        <IconChevronRightSmall size={12} aria-hidden className="agent-composer-model-row-chevron" />
      </button>
      {detail ? (
        <div ref={flyoutRef} className="agent-composer-model-flyout agent-composer-model-detail">
          <div className="agent-composer-model-surface">
            <ComposerModelCardContent model={detail.model} />
          </div>
        </div>
      ) : flyout?.kind === "all" ? (
        <div
          ref={flyoutRef}
          className="agent-composer-model-flyout agent-composer-model-all-panel"
          role="group"
          aria-label="All text models"
          onMouseLeave={() => {
            cancelHoverIntent();
            scheduleCatalogClose();
          }}
        >
          <div className="agent-composer-model-surface">
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
                aria-label="All text models"
                onScroll={() => {
                  updateFade();
                  cancelHoverIntent();
                  setCatalogHover(null);
                }}
              >
                {filteredOptions.length ? (
                  filteredOptions.map((option) => (
                    <ComposerModelOption
                      key={option.id}
                      model={option}
                      selected={option.id === model.id}
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
          </div>
        </div>
      ) : null}
      {flyout?.kind === "all" && catalogHover ? (
        <div
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
            <ComposerModelCardContent model={catalogHover.model} withDescription />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Footnote under the hero composer. June's agent runs on the user's Mac, but
// model calls go out to the provider, so the privacy claim has to match the
// active model: encrypted into the enclave (E2EE), private (zero retention),
// or anonymized (identity stripped, prompts may be retained). Name the model
// so it's clear what's running; fall back to the plain line when none is known.
export function heroPrivacyFootnote(
  model: VeniceModelDto | undefined,
  badge: ModelPrivacyBadge | undefined,
): string {
  if (!model) return "June runs locally.";
  switch (badge?.mode) {
    case "e2ee":
      return `June runs locally. Calls to ${model.name} are end-to-end encrypted.`;
    case "private":
      return `June runs locally. Calls to ${model.name} are private.`;
    case "anonymous":
      return `June runs locally. Calls to ${model.name} are anonymized.`;
    default:
      return `June runs locally. You're running ${model.name}.`;
  }
}

// Shared content of the model hover cards: name with the privacy chip
// alongside, then the value line (pricing, context window). The catalog
// card also carries the model's description, standing in for the native
// title tooltip it replaces.
function ComposerModelCardContent({
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
        <ComposerModelDescription text={model.description} />
      ) : null}
    </>
  );
}

// The catalog card clamps the description to two lines so it stays compact.
// When that clamp actually hides text, the row becomes its own hover tip
// carrying the full copy — hover the truncated blurb to read the rest. The tip
// only attaches when the text is clipped, so short descriptions don't get a
// redundant repeat of what's already fully visible.
function ComposerModelDescription({ text }: { text: string }) {
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

// Name-only rows: the composer popover is for quick switching, so pricing,
// context, and privacy detail live in the hover card beside the row.
function ComposerModelOption({
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
      <span className="agent-composer-model-row-name">{model.name}</span>
      {selected ? (
        <IconCheckmark1Small size={14} aria-hidden className="agent-composer-model-row-check" />
      ) : null}
    </button>
  );
}

function modelMatchesQuery(model: VeniceModelDto, query: string) {
  return [model.name, model.id, model.description, model.privacy, ...model.traits]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

// The current model's privacy mode as a pill — Private, Anonymous, or E2EE,
// with the same icons the composer model popover uses. The model itself is
// switched from the composer's picker; this badge just keeps the privacy
// claim visible while the conversation scrolls. The claims stay verifiable:
// the attestation walkthrough lives in Settings (Models and About) and
// onboarding.
export function PrivacyModeBadge({ badge }: { badge?: ModelPrivacyBadge }) {
  if (!badge) return null;
  // Delegates to the shared chip in the themed (brand-tinted pill) family so the
  // session bar and the usage panel render the same component. The look is
  // unchanged: themed-md keeps the 13px icon and the `.agent-safety-badge`
  // recipe; the aria-label now unifies to the shared "label: description" form.
  return <ModelPrivacyChip badge={badge} variant="themed" />;
}

// Indicator of the selected session's opt-in. The jail itself is
// per-process, but every send restarts the runtime into the target session's
// recorded mode, so the session — not the runtime's current state — is the
// honest unit to label.
export function UnrestrictedBadge() {
  const description =
    "This session runs without the file sandbox: June can change any file your account can. Sandboxed sessions keep their jail and run alongside on a separate, jailed runtime.";
  return (
    <HoverTip
      tip={description}
      className="agent-safety-badge agent-sandbox-badge"
      tabIndex={0}
      aria-label={`Unrestricted - ${description}`}
    >
      <IconShieldCrossed size={13} aria-hidden />
      Unrestricted
    </HoverTip>
  );
}
