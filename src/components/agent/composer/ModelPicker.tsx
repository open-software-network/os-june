import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { IconShieldCrossed } from "central-icons/IconShieldCrossed";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";

import {
  modelIsPrivate,
  modelSupportsTools,
  type ModelPrivacyBadge,
} from "../../../lib/model-privacy";
import { suggestedModelsForMode } from "../../../lib/suggested-models";
import type { VeniceModelDto } from "../../../lib/tauri";
import { useScrollFade } from "../../../lib/use-scroll-fade";
import { rectFromElement, type HoverBridgeRect } from "../../ui/hoverBridge";
import { useCatalogHoverBridge, useModelDetailHoverBridge } from "../../ui/useModelHoverBridge";
import { HoverTip } from "../../ui/HoverTip";
import { ModelPrivacyChip, ModelRowPrivacyBadge } from "../../ui/ModelPrivacyChip";
import { Switch } from "../../ui/Switch";
import { ModelPickerCardContent } from "../../settings/ModelPickerPopover";

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

// Row hovers should feel quick while moving through models, but still keep a
// tiny intent delay so a pointer sweep does not flash every card open. Click
// and keyboard focus stay immediate.
const MODEL_HOVER_OPEN_INTENT_MS = 45;
const MODEL_HOVER_CLOSE_INTENT_MS = 150;
const MODEL_HOVERCARD_W = 248;
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
  // "Private" catalog filter. Local to the popover on purpose: it resets when
  // the picker closes, so a stale filter can never silently hide models on the
  // next open.
  const [privateOnly, setPrivateOnly] = useState(false);
  // Styled hover card for catalog rows (replaces the native title tooltip):
  // fixed-positioned next to the hovered row, on the panel's outer side.
  const [catalogHover, setCatalogHover] = useState<{
    model: VeniceModelDto;
    rowRect: HoverBridgeRect;
    top: number;
    x: number;
    side: "left" | "right";
  } | null>(null);
  const hovercardRef = useRef<HTMLDivElement | null>(null);
  // The suggested-row detail card is portaled to document.body (so the note
  // chat panel's overflow/z-index can't clip or cover it) and positioned in
  // viewport coordinates beside the popover — the same mechanism as the catalog
  // hovercard below.
  const [detailPos, setDetailPos] = useState<{
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
      hoverTimerRef.current = window.setTimeout(action, MODEL_HOVER_OPEN_INTENT_MS);
    },
    [cancelHoverIntent],
  );
  useEffect(() => cancelHoverIntent, [cancelHoverIntent]);
  // The catalog hover card is interactive (the pointer can move onto it to
  // read), so it cannot vanish the instant the pointer leaves a row — it has
  // to survive the trip across the gap onto the card. A short close debounce
  // bridges that gap; entering the card or a fresh row cancels it.
  const closeTimerRef = useRef<number | null>(null);
  const cancelCatalogClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const scheduleCatalogClose = useCallback(() => {
    cancelCatalogClose();
    closeTimerRef.current = window.setTimeout(
      () => setCatalogHover(null),
      MODEL_HOVER_CLOSE_INTENT_MS,
    );
  }, [cancelCatalogClose]);
  useEffect(() => cancelCatalogClose, [cancelCatalogClose]);

  // While a safe-polygon traversal is in flight, a `data-hover-bridging` marker
  // on the popover suppresses the CSS `:hover` highlight on every non-active row
  // so only one row ever reads as active (see app.css). Toggled imperatively to
  // avoid a re-render on every pointermove.
  const setBridging = useCallback(
    (on: boolean) => {
      const el = popoverRef.current;
      if (!el) return;
      if (on) el.setAttribute("data-hover-bridging", "true");
      else el.removeAttribute("data-hover-bridging");
    },
    [popoverRef],
  );

  const portalTarget = typeof document === "undefined" ? null : document.body;
  // Position-aware scroll fades on the catalog list, via the shared primitive.
  const fade = useScrollFade(listRef);

  // The all-models panel stays anchored to the menu's bottom edge and grows
  // upward, so its height is capped to the room above — clearing the titlebar
  // strip, which would otherwise cover the search field — and to a fixed
  // ceiling so it doesn't tower on tall windows. (The suggested-model detail
  // card is positioned separately, below, since it's portaled to the body.)
  useLayoutEffect(() => {
    if (flyout?.kind !== "all") return;
    const el = flyoutRef.current;
    if (!el) return;
    el.dataset.side = "left";
    el.style.top = "";
    el.style.bottom = "";
    const titlebar = parseFloat(getComputedStyle(el).getPropertyValue("--titlebar-h")) || 0;
    const room = el.getBoundingClientRect().bottom - titlebar - 16;
    el.style.maxHeight = `${Math.max(160, Math.min(room, 400))}px`;
    if (el.getBoundingClientRect().left < 12) {
      el.dataset.side = "right";
    }
  }, [flyout]);

  // The detail card opens beside the popover, its top pinned to the active
  // row's top. It's portaled to the body (see render), so `offsetTop` is
  // meaningless — compute viewport-fixed coords here, the same math as
  // `showCatalogHover`. Prefer the composer side (left of the menu, where there
  // is reliably room); flip right only when the card wouldn't fit on the left.
  useLayoutEffect(() => {
    if (flyout?.kind !== "model") {
      setDetailPos(null);
      return;
    }
    const popover = popoverRef.current;
    const row = popover?.querySelector<HTMLElement>(
      '.agent-composer-model-row[data-active="true"]',
    );
    if (!popover || !row) {
      setDetailPos(null);
      return;
    }
    const rowRect = row.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const canOpenLeft =
      popoverRect.left -
        MODEL_HOVERCARD_GAP -
        MODEL_HOVERCARD_W -
        MODEL_HOVERCARD_VIEWPORT_MARGIN >=
      0;
    const canOpenRight =
      popoverRect.right +
        MODEL_HOVERCARD_GAP +
        MODEL_HOVERCARD_W +
        MODEL_HOVERCARD_VIEWPORT_MARGIN <=
      window.innerWidth;
    const side = canOpenLeft ? "left" : canOpenRight ? "right" : "left";
    setDetailPos({
      top: rowRect.top,
      x:
        side === "right"
          ? popoverRect.right + MODEL_HOVERCARD_GAP
          : popoverRect.left - MODEL_HOVERCARD_GAP,
      side,
    });
  }, [flyout, popoverRef]);

  // Keep the detail card on-screen: it's anchored to the active row's top, but
  // an expanded description near the viewport floor would run off the bottom.
  // Measure the real height and pull it up so its bottom stays visible.
  useLayoutEffect(() => {
    if (!detailPos) return;
    const card = flyoutRef.current;
    if (!card) return;
    const height = card.getBoundingClientRect().height;
    if (height <= 0) return;
    const maxTop = window.innerHeight - height - MODEL_HOVERCARD_VIEWPORT_MARGIN;
    setDetailPos((prev) => {
      if (!prev) return prev;
      const clampedTop = Math.max(MODEL_HOVERCARD_VIEWPORT_MARGIN, Math.min(prev.top, maxTop));
      return Math.abs(clampedTop - prev.top) > 0.5 ? { ...prev, top: clampedTop } : prev;
    });
  }, [detailPos]);

  // Re-measure the fades whenever the list's content or cap changes: panel
  // open (after the max-height effect above), every search keystroke, and the
  // privacy filter.
  useLayoutEffect(() => {
    fade.update();
  }, [flyout, search, privateOnly, options, fade.update]);

  // Row positions shift under the pointer on filter/reflow, so a lingering
  // card would point at the wrong row.
  useEffect(() => {
    setCatalogHover(null);
  }, [flyout, search, privateOnly]);

  const suggested = suggestedModelsForMode("generation", options);
  const query = search.trim().toLowerCase();
  // June's agent needs tool calls, so models without tool support can never
  // be picked — leave them out of the quick-switch list entirely instead of
  // showing dead rows. (Settings still lists them, greyed, for context.)
  const selectable = options.filter((option) => !option.provider || modelSupportsTools(option));
  const privacyFiltered = privateOnly ? selectable.filter(modelIsPrivate) : selectable;
  const filteredOptions = query
    ? privacyFiltered.filter((option) => modelMatchesQuery(option, query))
    : privacyFiltered;
  const detail =
    flyout?.kind === "model" ? suggested.find((item) => item.model.id === flyout.id) : undefined;

  // Latest filtered rows, read by the hand-off closure without re-subscribing
  // the pointer listener on every keystroke.
  const filteredOptionsRef = useRef(filteredOptions);
  filteredOptionsRef.current = filteredOptions;

  const showCatalogHover = useCallback(
    (option: VeniceModelDto, row: HTMLElement) => {
      cancelCatalogClose();
      const panel = flyoutRef.current;
      if (!panel) return;
      const rowRect = row.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const preferred = panel.dataset.side === "right" ? "right" : "left";
      const canOpenLeft =
        panelRect.left -
          MODEL_HOVERCARD_GAP -
          MODEL_HOVERCARD_W -
          MODEL_HOVERCARD_VIEWPORT_MARGIN >=
        0;
      const canOpenRight =
        panelRect.right +
          MODEL_HOVERCARD_GAP +
          MODEL_HOVERCARD_W +
          MODEL_HOVERCARD_VIEWPORT_MARGIN <=
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
        rowRect: rectFromElement(row),
        top: rowRect.top,
        x:
          side === "right"
            ? panelRect.right + MODEL_HOVERCARD_GAP
            : panelRect.left - MODEL_HOVERCARD_GAP,
        side,
      });
    },
    [cancelCatalogClose],
  );

  const resolveFilteredOption = useCallback(
    (id: string) => filteredOptionsRef.current.find((item) => item.id === id),
    [],
  );

  const modelBridge = useModelDetailHoverBridge({
    flyout,
    popoverRef,
    cardRef: flyoutRef,
    cancelHoverIntent,
    setBridging,
    onFlyoutChange,
  });

  const catalogBridge = useCatalogHoverBridge({
    catalogHover,
    cardRef: hovercardRef,
    listRef,
    resolveOption: resolveFilteredOption,
    showCatalogHover,
    cancelHoverIntent,
    cancelCatalogClose,
    scheduleCatalogClose,
    setBridging,
  });

  if (!model) return null;

  return (
    <div
      ref={popoverRef}
      className="agent-composer-model-popover"
      role="dialog"
      aria-label="Choose text model"
      // Opening/closing the detail flyout is owned by the safe-polygon listener;
      // leaving the popover drops a not-yet-fired open intent and lifts any
      // bridging suppression left by an abandoned re-target, so row hover
      // feedback can never stay dead.
      onPointerLeave={() => {
        cancelHoverIntent();
        setBridging(false);
      }}
    >
      <p className="agent-composer-model-title">Suggested</p>
      <div className="agent-composer-model-menu" role="listbox" aria-label="Suggested text models">
        {suggested.length ? (
          suggested.map(({ model: option }) => (
            <button
              key={option.id}
              type="button"
              className="agent-composer-model-row"
              role="option"
              aria-selected={option.id === model.id}
              data-model-id={option.id}
              data-active={(flyout?.kind === "model" && flyout.id === option.id) || undefined}
              onMouseEnter={() => {
                if (modelBridge.isActive()) {
                  return;
                }
                const open = () => onFlyoutChange({ kind: "model", id: option.id });
                if (flyout) {
                  cancelHoverIntent();
                  open();
                } else {
                  hoverIntent(open);
                }
              }}
              onFocus={() => {
                cancelHoverIntent();
                onFlyoutChange({ kind: "model", id: option.id });
              }}
              onClick={() => onSelect(option.id)}
            >
              <ComposerModelOptionText model={option} />
              {option.id === model.id ? (
                <IconCheckmark2Small
                  size={14}
                  aria-hidden
                  className="agent-composer-model-row-check"
                />
              ) : null}
              <ModelRowPrivacyBadge model={option} />
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
        onMouseEnter={() => {
          if (modelBridge.isActive()) {
            return;
          }
          const open = () => onFlyoutChange({ kind: "all" });
          if (flyout) {
            cancelHoverIntent();
            open();
          } else {
            hoverIntent(open);
          }
        }}
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
      {detail && portalTarget
        ? createPortal(
            // Portaled to the body and fixed-positioned so the note-chat panel's
            // overflow/z-index can't clip it or paint the resize divider over it.
            // Rendered as a .hovercard (position: fixed + z 140 + the slide
            // animation) rather than the absolute .flyout, but keeps
            // .agent-composer-model-detail for the card's own surface styles.
            <div
              ref={flyoutRef}
              className="agent-composer-model-hovercard agent-composer-model-detail"
              data-side={detailPos?.side ?? "left"}
              onPointerEnter={cancelHoverIntent}
              // Hidden for the one commit before the layout effect measures the
              // active row (which runs before paint, so no flash reaches screen).
              style={
                detailPos
                  ? detailPos.side === "right"
                    ? { top: detailPos.top, left: detailPos.x }
                    : { top: detailPos.top, right: window.innerWidth - detailPos.x }
                  : { visibility: "hidden" }
              }
            >
              <div className="agent-composer-model-surface">
                <ModelPickerCardContent model={detail.model} withDescription animateChange />
              </div>
            </div>,
            portalTarget,
          )
        : null}
      {flyout?.kind === "all" ? (
        <div
          ref={flyoutRef}
          className="agent-composer-model-flyout agent-composer-model-all-panel"
          role="group"
          aria-label="All text models"
          // Leaving the catalog panel abandons any pending re-target hover, so
          // also lift the bridging suppression here to keep row hover alive.
          onPointerLeave={() => {
            cancelHoverIntent();
            setBridging(false);
          }}
        >
          <div className="agent-composer-model-surface">
            <label className="agent-composer-model-search">
              <input
                ref={searchRef}
                value={search}
                onChange={(event) => onSearchChange(event.currentTarget.value)}
                placeholder="Search models"
                aria-label="Search models"
              />
            </label>
            <div className="agent-composer-model-filter">
              <span>Private</span>
              <Switch
                checked={privateOnly}
                onCheckedChange={setPrivateOnly}
                aria-label="Only show private models"
              />
            </div>
            <div className="agent-composer-model-list-wrap scroll-fade" {...fade.props}>
              <div
                ref={listRef}
                className="agent-composer-model-list"
                role="listbox"
                aria-label="All text models"
                onScroll={() => {
                  fade.update();
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
                      active={catalogHover?.model.id === option.id}
                      onSelect={onSelect}
                      onHover={(hoverModel, row, immediate) => {
                        if (!immediate && catalogBridge.isActive()) {
                          return;
                        }
                        cancelCatalogClose();
                        if (immediate || catalogHover) {
                          cancelHoverIntent();
                          showCatalogHover(hoverModel, row);
                        } else {
                          hoverIntent(() => showCatalogHover(hoverModel, row));
                        }
                      }}
                    />
                  ))
                ) : (
                  <p className="agent-composer-model-empty">
                    {privateOnly
                      ? query
                        ? "No private models match your search."
                        : "No private models available."
                      : "No models match your search."}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {flyout?.kind === "all" && catalogHover && portalTarget
        ? createPortal(
            // Portaled alongside the detail card for the same reason: it's a DOM
            // descendant of the note-chat panel otherwise, trapped below the
            // resize handle even though it's already position: fixed.
            <div
              ref={hovercardRef}
              className="agent-composer-model-hovercard agent-composer-model-detail"
              data-side={catalogHover.side}
              onPointerEnter={cancelCatalogClose}
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
                <ModelPickerCardContent model={catalogHover.model} withDescription animateChange />
              </div>
            </div>,
            portalTarget,
          )
        : null}
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

// Name-only rows: the composer popover is for quick switching, so pricing,
// context, and privacy detail live in the hover card beside the row.
function ComposerModelOption({
  model,
  selected,
  active,
  onSelect,
  onHover,
}: {
  model: VeniceModelDto;
  selected: boolean;
  active?: boolean;
  onSelect: (modelId: string) => void;
  onHover: (model: VeniceModelDto, row: HTMLElement, immediate: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="agent-composer-model-row"
      role="option"
      aria-selected={selected}
      data-model-id={model.id}
      data-active={active || undefined}
      onMouseEnter={(event) => onHover(model, event.currentTarget, false)}
      onFocus={(event) => onHover(model, event.currentTarget, true)}
      onClick={() => onSelect(model.id)}
    >
      <ComposerModelOptionText model={model} />
      {selected ? (
        <IconCheckmark2Small size={14} aria-hidden className="agent-composer-model-row-check" />
      ) : null}
      <ModelRowPrivacyBadge model={model} />
    </button>
  );
}

function ComposerModelOptionText({ model }: { model: VeniceModelDto }) {
  return (
    <span className="agent-composer-model-row-copy">
      <span className="agent-composer-model-row-name">{model.name}</span>
    </span>
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
