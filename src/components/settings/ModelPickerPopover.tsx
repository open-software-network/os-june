import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { IconCheckmark2Small } from "central-icons-filled/IconCheckmark2Small";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { modelAvailableForMode, modelIsPrivate, modelPrivacyBadge } from "../../lib/model-privacy";
import { modelMatchesQuery } from "../../lib/model-search";
import {
  DEFAULT_GENERATION_SUGGESTION_ID,
  suggestedModelsForMode,
} from "../../lib/suggested-models";
import type { ProviderModelMode, VeniceModelDto } from "../../lib/tauri";
import {
  thinkingOptionForLevel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../../lib/thinking-level";
import { useScrollFade } from "../../lib/use-scroll-fade";
import { rectFromElement, type HoverBridgeRect } from "../ui/hoverBridge";
import { useCatalogHoverBridge, useModelDetailHoverBridge } from "../ui/useModelHoverBridge";
import { ModelPrivacyChip, ModelRowPrivacyBadge } from "../ui/ModelPrivacyChip";
import { Switch } from "../ui/Switch";
import { AUTO_MODEL_ID, modelSpecEntries } from "./ModelPickerDialog";
import { ProviderLogo } from "./ProviderLogo";

export type ModelPickerFlyout =
  | { kind: "model"; id: string }
  | { kind: "all" }
  | { kind: "auto" }
  | { kind: "effort" }
  | null;

// The automatic router's cost-to-quality preference, shared by this popover's
// Auto section and the Settings "Auto preference" row so both surfaces read
// and write the same three presets.
export type AutoPreference = "cost" | "balanced" | "quality";

export const AUTO_PREFERENCE_VALUES: Record<AutoPreference, number> = {
  // Keep the cost-first preset above the lowest-quality routing tier. Live
  // integration evals showed that tier dropping facts and inventing dates.
  cost: 20,
  balanced: 50,
  quality: 100,
};

export function autoPreferenceFromCostQuality(value: number): AutoPreference {
  if (value < 34) return "cost";
  if (value > 66) return "quality";
  return "balanced";
}

// The Preference flyout's option rows: each preset carries a one-line
// explanation, which is the point of drilling in rather than showing bare
// values.
const AUTO_PREFERENCE_DETAILS: readonly {
  value: AutoPreference;
  label: string;
  description: string;
}[] = [
  {
    value: "cost",
    label: "Lower cost",
    description: "Favors cheaper models to stretch your credits.",
  },
  {
    value: "balanced",
    label: "Balanced",
    description: "Weighs quality against cost on every request.",
  },
  {
    value: "quality",
    label: "Higher quality",
    description: "Routes to the strongest model for the job.",
  },
];

// Row hovers should feel quick while moving through models, but still keep a
// tiny intent delay so a pointer sweep does not flash every card open.
const MODEL_HOVER_OPEN_INTENT_MS = 45;
const MODEL_HOVER_CLOSE_INTENT_MS = 150;
const MODEL_HOVERCARD_W = 248;
const MODEL_HOVERCARD_GAP = 4;
const MODEL_HOVERCARD_VIEWPORT_MARGIN = 12;

export function ModelPickerPopover({
  mode,
  flyout,
  model,
  options,
  costQuality,
  search,
  popoverRef,
  searchRef,
  className,
  title = "Suggested",
  ariaLabel = `Choose ${modelModeLabel(mode)} model`,
  suggestedListLabel = `Suggested ${modelModeLabel(mode)} models`,
  allModelsLabel = `All ${modelModeLabel(mode)} models`,
  veniceApiKeyConfigured = false,
  onFlyoutChange,
  onSearchChange,
  onSelect,
  onCostQualityChange,
  thinkingLevel,
  onSelectThinking,
}: {
  mode: ProviderModelMode;
  flyout: ModelPickerFlyout;
  model?: VeniceModelDto;
  options: VeniceModelDto[];
  costQuality?: number;
  search: string;
  popoverRef: RefObject<HTMLDivElement>;
  searchRef: RefObject<HTMLInputElement>;
  className?: string;
  title?: string;
  ariaLabel?: string;
  suggestedListLabel?: string;
  allModelsLabel?: string;
  /** With a Venice API key saved, the pinned Auto section carries a billing
   * note: Auto is a June-managed route, so it meters June credits and never
   * uses the key. The note keeps that visible at the moment Auto could be
   * switched on (JUN-329). */
  veniceApiKeyConfigured?: boolean;
  onFlyoutChange: (flyout: ModelPickerFlyout) => void;
  onSearchChange: (value: string) => void;
  /** `keepOpen` asks the host to leave the popover mounted (used by the Auto
   * toggle, where switching is a mid-flow adjustment, not a final pick). */
  onSelect: (modelId: string, costQuality?: number, options?: { keepOpen?: boolean }) => void;
  /** Enables the pinned Auto section (generation surfaces): a toggle that
   * swaps the selection to/from the Auto router, plus the Preference
   * drill-in writing through this callback while Auto is on. */
  onCostQualityChange?: (value: number) => void;
  /** Enables the Effort drill-in row (agent surfaces): shows the session's
   * thinking level and opens the three-level submenu. Omitted on surfaces
   * without reasoning effort control (image/video pickers). */
  thinkingLevel?: ThinkingLevel;
  onSelectThinking?: (level: ThinkingLevel) => void;
}) {
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const hovercardRef = useRef<HTMLDivElement | null>(null);
  // "Private" catalog filter. Local to the popover on purpose: it resets when
  // the picker closes, so a stale filter can never silently hide models on the
  // next open.
  const [privateOnly, setPrivateOnly] = useState(false);
  // The suggested-row detail card is portaled to document.body (so a scroll
  // container or panel can't clip or cover it) and positioned in viewport
  // coordinates beside the popover — the same mechanism as the catalog
  // hovercard below.
  const [detailPos, setDetailPos] = useState<{
    top: number;
    x: number;
    side: "left" | "right";
  } | null>(null);
  const [catalogHover, setCatalogHover] = useState<{
    model: VeniceModelDto;
    rowRect: HoverBridgeRect;
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
      hoverTimerRef.current = window.setTimeout(action, MODEL_HOVER_OPEN_INTENT_MS);
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

  const fade = useScrollFade(listRef);

  // The all-models panel stays anchored to the menu's bottom edge and grows
  // upward; cap its height to the room above (clearing the titlebar strip that
  // would otherwise cover the search field) and a fixed ceiling. (The
  // suggested-model detail card is positioned separately, below, since it's
  // portaled to the body.)
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
  // `showCatalogHover`. Prefer the left side; flip right only when the card
  // wouldn't fit on the left.
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
  // the picker opens downward, so a row near the viewport floor (or an expanded
  // description) would push the card off the bottom. Measure the real height
  // and pull it up so its bottom stays visible.
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

  useLayoutEffect(() => {
    fade.update();
  }, [flyout, options, search, privateOnly, fade.update]);

  useEffect(() => {
    setCatalogHover(null);
  }, [flyout, search, privateOnly]);

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
    setCatalogHover((prev) => {
      if (!prev) return prev;
      const clampedTop = Math.max(MODEL_HOVERCARD_VIEWPORT_MARGIN, Math.min(prev.top, maxTop));
      return Math.abs(clampedTop - prev.top) > 0.5 ? { ...prev, top: clampedTop } : prev;
    });
  }, [catalogHover]);

  const query = search.trim().toLowerCase();
  const selectable = useMemo(
    () =>
      options.filter(
        (option) =>
          modelAvailableForMode(mode, option) &&
          // With the Auto section shown, the toggle is the router's one home;
          // keep the catalog's Auto entry out of the lists so it doesn't
          // double up as a row.
          !(onCostQualityChange && option.id === AUTO_MODEL_ID),
      ),
    [mode, onCostQualityChange, options],
  );
  const suggested = useMemo(() => suggestedModelsForMode(mode, selectable), [mode, selectable]);
  const autoEnabled = onCostQualityChange !== undefined && model?.id === AUTO_MODEL_ID;
  const autoPreference = autoPreferenceFromCostQuality(costQuality ?? 100);
  // Toggling stays inside the popover: turning Auto off lands on the leading
  // suggested pick (the default generation model) so the next step — choosing
  // an explicit model — is right there, one row away.
  // The concrete model toggling Auto off lands on: the leading suggested
  // pick, else the first selectable catalog model, else the curated default
  // id — the factory default keeps the switch actionable while the catalog
  // is empty or unloaded, and is safe to select sight-unseen.
  const autoOffTarget =
    suggested.find((item) => item.model.id !== AUTO_MODEL_ID)?.model.id ??
    selectable.find((option) => option.id !== AUTO_MODEL_ID)?.id ??
    DEFAULT_GENERATION_SUGGESTION_ID;
  const toggleAuto = useCallback(
    (on: boolean) => {
      onFlyoutChange(null);
      if (on) {
        onSelect(AUTO_MODEL_ID, undefined, { keepOpen: true });
        return;
      }
      onSelect(autoOffTarget, undefined, { keepOpen: true });
    },
    [autoOffTarget, onFlyoutChange, onSelect],
  );
  const privacyFiltered = privateOnly ? selectable.filter(modelIsPrivate) : selectable;
  const filteredOptions = query
    ? privacyFiltered.filter((option) => modelMatchesQuery(option, query))
    : privacyFiltered;
  const detail =
    flyout?.kind === "model" ? suggested.find((item) => item.key === flyout.id) : undefined;

  // Latest filtered rows, read by the hand-off closure without re-subscribing
  // the pointer listener on every keystroke.
  const filteredOptionsRef = useRef(filteredOptions);
  filteredOptionsRef.current = filteredOptions;

  const showCatalogHover = useCallback(
    (option: VeniceModelDto, row: HTMLElement) => {
      cancelCatalogClose();
      const panel = flyoutRef.current ?? popoverRef.current;
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
    [cancelCatalogClose, popoverRef],
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

  function catalogList(label: string) {
    return (
      <>
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
            aria-label={label}
            onScroll={() => {
              fade.update();
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
      // Opening/closing the detail flyout is owned by the safe-polygon listener;
      // leaving the popover drops a not-yet-fired open intent and lifts any
      // bridging suppression left by an abandoned re-target, so row hover
      // feedback can never stay dead.
      onPointerLeave={() => {
        cancelHoverIntent();
        setBridging(false);
      }}
    >
      <p className="agent-composer-model-title">{title}</p>
      {onCostQualityChange ? (
        <div className="agent-composer-model-auto">
          <div className="agent-composer-model-filter agent-composer-model-auto-toggle">
            <span>Auto</span>
            <Switch
              checked={autoEnabled}
              onCheckedChange={toggleAuto}
              aria-label="Choose the model automatically"
            />
          </div>
          {veniceApiKeyConfigured ? (
            <p className="agent-composer-model-auto-note">
              Auto is billed to June credits and does not use your Venice API key.
            </p>
          ) : null}
          {autoEnabled ? (
            <button
              type="button"
              className="agent-composer-model-row agent-composer-model-auto-row"
              aria-haspopup="true"
              aria-expanded={flyout?.kind === "auto"}
              data-active={flyout?.kind === "auto" || undefined}
              onMouseEnter={() => {
                if (modelBridge.isActive()) {
                  return;
                }
                const open = () => onFlyoutChange({ kind: "auto" });
                if (flyout) {
                  cancelHoverIntent();
                  open();
                } else {
                  hoverIntent(open);
                }
              }}
              onFocus={() => {
                cancelHoverIntent();
                onFlyoutChange({ kind: "auto" });
              }}
              onClick={() => {
                cancelHoverIntent();
                onFlyoutChange({ kind: "auto" });
              }}
            >
              <span className="agent-composer-model-row-name">Preference</span>
              <span className="agent-composer-model-auto-value">
                {AUTO_PREFERENCE_DETAILS.find((option) => option.value === autoPreference)?.label}
              </span>
              <IconChevronRightSmall
                size={16}
                aria-hidden
                className="agent-composer-model-row-chevron"
              />
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="agent-composer-model-menu" role="listbox" aria-label={suggestedListLabel}>
        {suggested.length ? (
          suggested.map(({ key, model: option, costQuality: presetCostQuality }) => (
            <button
              key={key}
              type="button"
              className="agent-composer-model-row"
              role="option"
              aria-selected={
                option.id === model.id &&
                (presetCostQuality === undefined || presetCostQuality === costQuality)
              }
              data-model-id={key}
              data-active={(flyout?.kind === "model" && flyout.id === key) || undefined}
              onMouseEnter={() => {
                if (modelBridge.isActive()) {
                  return;
                }
                const open = () => onFlyoutChange({ kind: "model", id: key });
                if (flyout) {
                  cancelHoverIntent();
                  open();
                } else {
                  hoverIntent(open);
                }
              }}
              onFocus={() => {
                cancelHoverIntent();
                onFlyoutChange({ kind: "model", id: key });
              }}
              onClick={() => onSelect(option.id, presetCostQuality)}
            >
              <ModelPickerOptionText model={option} />
              {option.id === model.id &&
              (presetCostQuality === undefined || presetCostQuality === costQuality) ? (
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
        <IconChevronRightSmall size={16} aria-hidden className="agent-composer-model-row-chevron" />
      </button>
      {thinkingLevel && onSelectThinking ? (
        <button
          type="button"
          className="agent-composer-model-row"
          aria-haspopup="true"
          aria-expanded={flyout?.kind === "effort"}
          data-active={flyout?.kind === "effort" || undefined}
          onMouseEnter={() => {
            if (modelBridge.isActive()) {
              return;
            }
            const open = () => onFlyoutChange({ kind: "effort" });
            if (flyout) {
              cancelHoverIntent();
              open();
            } else {
              hoverIntent(open);
            }
          }}
          onFocus={() => {
            cancelHoverIntent();
            onFlyoutChange({ kind: "effort" });
          }}
          onClick={() => {
            cancelHoverIntent();
            onFlyoutChange({ kind: "effort" });
          }}
        >
          <span className="agent-composer-model-row-name">Effort</span>
          <span className="agent-composer-model-row-value">
            {thinkingOptionForLevel(thinkingLevel).label}
          </span>
          <IconChevronRightSmall
            size={16}
            aria-hidden
            className="agent-composer-model-row-chevron"
          />
        </button>
      ) : null}
      {detail && portalTarget
        ? createPortal(
            // Portaled to the body and fixed-positioned so no scroll container
            // or panel (e.g. the note-chat panel) can clip it or paint over it.
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
          aria-label={allModelsLabel}
          // Leaving the catalog panel abandons any pending re-target hover, so
          // also lift the bridging suppression here to keep row hover alive.
          onPointerLeave={() => {
            cancelHoverIntent();
            setBridging(false);
          }}
        >
          <div className="agent-composer-model-surface">{catalogList(allModelsLabel)}</div>
        </div>
      ) : null}
      {onCostQualityChange && flyout?.kind === "auto" ? (
        <div
          ref={flyoutRef}
          className="agent-composer-model-flyout agent-composer-model-auto-panel"
          role="group"
          aria-label="Auto preference"
          onPointerLeave={() => {
            cancelHoverIntent();
            setBridging(false);
          }}
        >
          <div className="agent-composer-model-surface">
            {AUTO_PREFERENCE_DETAILS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="agent-composer-model-row agent-composer-model-pref-option"
                role="menuitemradio"
                aria-checked={option.value === autoPreference}
                onClick={() => onCostQualityChange(AUTO_PREFERENCE_VALUES[option.value])}
              >
                <span className="agent-composer-model-pref-copy">
                  <span className="agent-composer-model-row-name">{option.label}</span>
                  <span className="agent-composer-model-pref-desc">{option.description}</span>
                </span>
                {option.value === autoPreference ? (
                  <IconCheckmark2Small
                    size={14}
                    aria-hidden
                    className="agent-composer-model-row-check"
                  />
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {thinkingLevel && onSelectThinking && flyout?.kind === "effort" ? (
        <div
          ref={flyoutRef}
          className="agent-composer-model-flyout agent-composer-model-effort-panel"
          role="group"
          aria-label="Thinking level"
          onPointerLeave={() => {
            cancelHoverIntent();
            setBridging(false);
          }}
        >
          <div className="agent-composer-model-surface">
            <p className="agent-composer-model-title">Effort</p>
            <div className="agent-composer-model-menu" role="listbox" aria-label="Thinking level">
              {THINKING_LEVELS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="agent-composer-model-row"
                  role="option"
                  aria-selected={option.id === thinkingLevel}
                  onClick={() => onSelectThinking(option.id)}
                >
                  <span className="agent-composer-model-row-name">{option.label}</span>
                  {option.id === thinkingLevel ? (
                    <IconCheckmark2Small
                      size={14}
                      aria-hidden
                      className="agent-composer-model-row-check"
                    />
                  ) : null}
                </button>
              ))}
            </div>
            <p className="agent-composer-model-note">Higher effort consumes usage limits faster.</p>
          </div>
        </div>
      ) : null}
      {flyout?.kind === "all" && catalogHover && portalTarget
        ? createPortal(
            // Portaled alongside the detail card, for the same reason.
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

/** Single-panel catalog opened by submitting bare `/model` in the composer.
 * It keeps the curated picks pinned above the rest of the searchable catalog,
 * using the same row, provider, privacy, and selection language as the compact
 * toolbar picker. */
const AUTO_COMMAND_DESCRIPTION = "Chooses a private model for each request using your preference.";

export function ModelCommandPalette({
  model,
  options,
  search,
  popoverRef,
  searchRef,
  onSearchChange,
  onSelect,
}: {
  model?: VeniceModelDto;
  options: VeniceModelDto[];
  search: string;
  popoverRef: RefObject<HTMLDivElement>;
  searchRef: RefObject<HTMLInputElement>;
  onSearchChange: (value: string) => void;
  onSelect: (modelId: string) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const fade = useScrollFade(listRef);
  const listId = useId();
  const [privateOnly, setPrivateOnly] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const query = search.trim().toLowerCase();
  const selectable = useMemo(
    () =>
      options.flatMap((option) => {
        if (option.id === AUTO_MODEL_ID) {
          // Auto is June's routing choice, not one direct inference model, so
          // it has no catalog function-calling flag of its own. Its routing
          // policy is private; concrete models still use the capability gate.
          return [{ ...option, name: "Auto", privacy: option.privacy ?? "private" }];
        }
        return modelAvailableForMode("generation", option) ? [option] : [];
      }),
    [options],
  );
  const privacyFiltered = useMemo(
    () => (privateOnly ? selectable.filter(modelIsPrivate) : selectable),
    [privateOnly, selectable],
  );
  const matching = useMemo(
    () =>
      query
        ? privacyFiltered.filter((option) => modelMatchesQuery(option, query))
        : privacyFiltered,
    [privacyFiltered, query],
  );
  const suggested = useMemo(() => suggestedModelsForMode("generation", selectable), [selectable]);
  const auto = selectable.find((option) => option.id === AUTO_MODEL_ID);
  const matchingSuggested = [
    ...(auto && matching.some((candidate) => candidate.id === AUTO_MODEL_ID)
      ? [{ key: AUTO_MODEL_ID, model: auto, reason: AUTO_COMMAND_DESCRIPTION }]
      : []),
    ...suggested.filter(
      ({ model: option }) =>
        option.id !== AUTO_MODEL_ID && matching.some((candidate) => candidate.id === option.id),
    ),
  ];
  const suggestedIds = new Set(matchingSuggested.map(({ model: option }) => option.id));
  const remaining = matching.filter((option) => !suggestedIds.has(option.id));
  const resultRows = [
    ...matchingSuggested.map(({ model: option, reason }) => ({ option, description: reason })),
    ...remaining.map((option) => ({ option, description: option.description })),
  ];
  const resolvedActiveIndex = Math.min(activeIndex, Math.max(resultRows.length - 1, 0));

  useEffect(() => {
    setActiveIndex(0);
  }, [privateOnly, query]);

  useLayoutEffect(() => {
    fade.update();
  }, [fade.update, matchingSuggested.length, remaining.length]);

  function moveActive(delta: number) {
    if (!resultRows.length) return;
    setActiveIndex((current) => {
      const currentIndex = Math.min(current, resultRows.length - 1);
      const nextIndex = (currentIndex + delta + resultRows.length) % resultRows.length;
      window.requestAnimationFrame(() => {
        document
          .getElementById(`${listId}-option-${nextIndex}`)
          ?.scrollIntoView?.({ block: "nearest" });
      });
      return nextIndex;
    });
  }

  const modelRow = (option: VeniceModelDto, description: string | undefined, index: number) => (
    <button
      key={option.id}
      id={`${listId}-option-${index}`}
      type="button"
      className="agent-composer-model-row agent-composer-model-command-row"
      role="option"
      tabIndex={-1}
      aria-selected={option.id === model?.id}
      data-active={index === resolvedActiveIndex || undefined}
      onFocus={() => setActiveIndex(index)}
      onPointerMove={() => setActiveIndex(index)}
      onClick={() => onSelect(option.id)}
    >
      <span className="agent-composer-model-row-logo" aria-hidden>
        <ProviderLogo provider={option.provider} id={option.id} name={option.name} />
      </span>
      <span className="agent-composer-model-row-copy">
        <span className="agent-composer-model-row-name">{option.name}</span>
        {description ? (
          <span className="agent-composer-model-command-description">{description}</span>
        ) : null}
      </span>
      {option.id === model?.id ? (
        <IconCheckmark2Small size={14} aria-hidden className="agent-composer-model-row-check" />
      ) : null}
      <ModelRowPrivacyBadge model={option} />
    </button>
  );

  return (
    <div
      ref={popoverRef}
      className="agent-composer-model-popover agent-composer-model-command-palette"
      role="dialog"
      aria-label="Choose text model"
    >
      <label className="agent-composer-model-search">
        <input
          ref={searchRef}
          value={search}
          onChange={(event) => onSearchChange(event.currentTarget.value)}
          placeholder="Search models"
          aria-label="Search models"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={
            resultRows.length ? `${listId}-option-${resolvedActiveIndex}` : undefined
          }
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActive(1);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActive(-1);
              return;
            }
            if (event.key === "Enter" && resultRows.length) {
              event.preventDefault();
              event.stopPropagation();
              onSelect(resultRows[resolvedActiveIndex].option.id);
            }
          }}
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
      <div className="agent-composer-model-command-list-wrap scroll-fade" {...fade.props}>
        <div
          ref={listRef}
          id={listId}
          className="agent-composer-model-command-list"
          role="listbox"
          aria-label="Text models"
        >
          {matchingSuggested.length ? (
            <div
              className="agent-composer-model-command-section"
              role="group"
              aria-labelledby={`${listId}-suggested-label`}
            >
              <p
                id={`${listId}-suggested-label`}
                className="agent-composer-model-command-section-label"
              >
                Suggested
              </p>
              {matchingSuggested.map(({ model: option, reason }, index) =>
                modelRow(option, reason, index),
              )}
            </div>
          ) : null}
          {matchingSuggested.length && remaining.length ? (
            <hr className="agent-composer-model-command-divider" role="presentation" />
          ) : null}
          {remaining.length ? (
            <div
              className="agent-composer-model-command-section"
              role="group"
              aria-labelledby={`${listId}-all-label`}
            >
              <p id={`${listId}-all-label`} className="agent-composer-model-command-section-label">
                All models
              </p>
              {remaining.map((option, index) =>
                modelRow(option, option.description, matchingSuggested.length + index),
              )}
            </div>
          ) : null}
        </div>
        {!resultRows.length ? (
          <p className="agent-composer-model-empty" role="status">
            {privateOnly
              ? query
                ? "No private models match your search."
                : "No private models available."
              : "No models match your search."}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// The card: name + privacy chip, the full description in a capped scroll box,
// then the pricing/context facts as a compact spec list. The description never
// grows the card after it opens (no "Show more" toggle), so the open-time
// viewport clamp stays correct and there is no focusable control stranded
// inside the portaled subtree.
export function ModelPickerCardContent({
  model,
  withDescription,
  animateChange = false,
}: {
  model: VeniceModelDto;
  withDescription?: boolean;
  animateChange?: boolean;
}) {
  const badge = modelPrivacyBadge(model);
  const specs = modelSpecEntries(model);
  return (
    <div
      key={animateChange ? model.id : undefined}
      className="agent-composer-model-detail-content"
      data-animate-change={animateChange || undefined}
    >
      <p className="agent-composer-model-detail-name">
        <span>{model.name}</span>
        {badge ? (
          <ModelPrivacyChip
            badge={badge}
            withTip={false}
            variant="themed"
            size="sm"
            label={badge.label.replace(" mode", "")}
          />
        ) : null}
      </p>
      {withDescription && model.description ? (
        // Keyed by model so switching rows re-measures the fade from the top.
        <ModelCardDescription key={model.id} text={model.description} />
      ) : null}
      {specs.length ? (
        <dl className="agent-composer-model-detail-specs">
          {specs.map((spec) => (
            <Fragment key={spec.label}>
              <dt>{spec.label}</dt>
              <dd>{spec.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

// Full description in a short capped box that scrolls when it overflows, with
// contained top/bottom scroll fades from the shared `useScrollFade` primitive
// (WKWebView-safe overlay flavor — never a mask on the scroller itself).
function ModelCardDescription({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement | null>(null);
  const fade = useScrollFade(ref);
  return (
    <div className="agent-composer-model-detail-desc-wrap scroll-fade" {...fade.props}>
      <p ref={ref} className="agent-composer-model-detail-desc">
        {text}
      </p>
    </div>
  );
}

function ModelPickerOption({
  model,
  selected,
  active,
  onSelect,
  onHover,
}: {
  model: VeniceModelDto;
  selected: boolean;
  active?: boolean;
  onSelect: (modelId: string, costQuality?: number) => void;
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
      <ModelPickerOptionText model={model} />
      {selected ? (
        <IconCheckmark2Small size={14} aria-hidden className="agent-composer-model-row-check" />
      ) : null}
      <ModelRowPrivacyBadge model={model} />
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

function modelModeLabel(mode: ProviderModelMode) {
  if (mode === "generation") return "text";
  return mode;
}
