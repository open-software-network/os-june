import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconChecklist } from "central-icons/IconChecklist";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconEmail1Sparkle } from "central-icons/IconEmail1Sparkle";
import { IconFileSparkle } from "central-icons/IconFileSparkle";
import { IconFlag1 } from "central-icons/IconFlag1";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconStop } from "central-icons/IconStop";
import { IconExclamationTriangle } from "central-icons/IconExclamationTriangle";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import {
  displayedComposerUserMessageText,
  stripRenderedMediaReferences,
  type AgentChatPart,
  type AgentChatTurn,
  UPSTREAM_PROVIDER_FAILURE_NOTICE_BODY,
} from "../../lib/agent-chat-runtime";
import { shouldBlockTextOnFunding, type TextFundingModelContext } from "../../lib/account-gate";
import { messageFromError } from "../../lib/errors";
import {
  upstreamProviderRecoveryIds,
  upstreamProviderRecoveryStore,
} from "../../lib/upstream-provider-recovery";
import { attachmentStateFrom } from "../../lib/hermes-image-attach";
import {
  decodeHermesModelSelection,
  type SessionModelSelection,
} from "../../lib/hermes-session-model-selection";
import {
  isLoopbackUrl,
  LOCAL_GENERATION_OPTION_ID_PREFIX,
  localGenerationOptionId,
  unavailableLocalGenerationOption,
  withLocalGenerationOption,
} from "../../lib/local-generation";
import { useScrollFade } from "../../lib/use-scroll-fade";
import { dispatchProviderModelSettingsChanged } from "../../lib/model-privacy";
import {
  dictationHelperCommand,
  importHermesBridgeFile,
  listVeniceModels,
  providerModelSettings,
  setCostQuality,
  setLocalGenerationEnabled,
  setVeniceModel,
  type LocalGenerationSettingsDto,
  type VeniceModelDto,
} from "../../lib/tauri";
import { FileTypeIcon } from "../agent/FileTypeIcon";
import { MarkdownContent } from "../agent/MarkdownContent";
import { InlineNotice } from "../ui/InlineNotice";
import { ComposerEditor, type ComposerEditorHandle } from "../agent/composer/ComposerEditor";
import {
  ComposerModelPicker,
  ComposerModelPopover,
  type ComposerModelFlyout,
} from "../agent/composer/ModelPicker";
import { autoPillDesignation } from "../../lib/suggested-models";
import { AUTO_MODEL_ID, modelOptions, selectedModel } from "../settings/ModelPickerDialog";
import type { TextFundingNoticeContext } from "../account/FundingNotice";
import type { NoteChat, NoteChatAttachment } from "./useNoteChat";

/** Note-tailored presets, shown as the main session view's preset chips (icon
 * + label). Like those, a click prefills the composer rather than sending —
 * the prompt lands in the box so the person sees exactly what will run before
 * spending credits. The note reference is prepended by useNoteChat on the
 * first message, so these are just the questions. */
type NotePreset = { key: string; icon: ReactNode; label: string; prompt: string };

const NOTE_PRESETS: NotePreset[] = [
  {
    key: "summary",
    icon: <IconFileSparkle size={16} />,
    label: "Summarize",
    prompt: "Summarize this note.",
  },
  {
    key: "actions",
    icon: <IconChecklist size={16} />,
    label: "Action items",
    prompt: "List the action items from this note and who owns each.",
  },
  {
    key: "decisions",
    icon: <IconFlag1 size={16} />,
    label: "Key decisions",
    prompt: "What decisions were made in this note?",
  },
  {
    key: "followup",
    icon: <IconEmail1Sparkle size={16} />,
    label: "Draft follow-up",
    prompt: "Draft a follow-up email summarizing this note and its action items.",
  },
];

const NOTE_CHAT_WIDTH_KEY = "june:note-chat:panel-width";
const NOTE_CHAT_MIN_W = 300;
const NOTE_CHAT_MAX_W = 600;

function clampNoteChatWidth(width: number) {
  const viewportCap =
    typeof window === "undefined" ? NOTE_CHAT_MAX_W : Math.round(window.innerWidth * 0.48);
  const max = Math.max(NOTE_CHAT_MIN_W, Math.min(NOTE_CHAT_MAX_W, viewportCap));
  return Math.min(Math.max(Math.round(width), NOTE_CHAT_MIN_W), max);
}

function selectionForAppliedHermesModel(
  appliedHermesModelId: string | undefined,
  localGeneration: LocalGenerationSettingsDto,
): SessionModelSelection | undefined {
  const modelId = appliedHermesModelId?.trim();
  if (!modelId) return undefined;
  const configuredLocalModelId = localGeneration.modelId.trim();
  if (
    !modelId.startsWith("__june_") &&
    configuredLocalModelId &&
    modelId === configuredLocalModelId
  ) {
    return { modelId: localGenerationOptionId(configuredLocalModelId) };
  }
  return decodeHermesModelSelection(modelId);
}

/** The first message of a note chat carries the note reference token so
 * Hermes resolves the note; the panel already says which note it's about, so
 * the token is chrome, not content, in the panel's own transcript. */
function stripLeadingNoteToken(text: string) {
  return text.replace(/^@note:[\w-]+(?: \("[^"]*"\))?\s*/, "");
}

function userTurnText(turn: AgentChatTurn) {
  return turn.parts
    .map((part) =>
      part.type === "text"
        ? displayedComposerUserMessageText(stripLeadingNoteToken(part.text))
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function turnContainsMediaStructure(turn: Pick<AgentChatTurn, "parts">) {
  return turn.parts.some(
    (part) =>
      part.type === "image" ||
      part.type === "video" ||
      (part.type === "tool" && part.media !== undefined),
  );
}

function assistantPartNode(
  part: AgentChatPart,
  index: number,
  holdTrailingMediaTransport: boolean,
  upstreamFailureRetry?: {
    attempted: boolean;
    disabled: boolean;
    onRetry: () => void;
  },
) {
  switch (part.type) {
    case "text":
      return (
        <MarkdownContent
          key={part.renderKey ?? index}
          markdown={stripRenderedMediaReferences(
            part.text,
            part.status === "running" || holdTrailingMediaTransport,
          )}
          repairProse
        />
      );
    case "notice":
      if (part.kind === "upstream-provider") {
        return (
          <InlineNotice
            key={index}
            tone="warning"
            role="alert"
            icon={<IconExclamationTriangle size={14} aria-hidden />}
            body={UPSTREAM_PROVIDER_FAILURE_NOTICE_BODY}
            actions={
              upstreamFailureRetry ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={upstreamFailureRetry.disabled || upstreamFailureRetry.attempted}
                  onClick={upstreamFailureRetry.onRetry}
                >
                  Try again
                </button>
              ) : undefined
            }
          />
        );
      }
      return <MarkdownContent key={index} markdown={part.text} />;
    case "tool":
      return (
        <div
          key={index}
          className="note-chat-tool"
          data-running={part.status === "running" || undefined}
        >
          {part.name}
        </div>
      );
    default:
      // Reasoning, approvals, images and the other rich parts stay in the
      // full agent view; the panel keeps to prose + tool beats and offers
      // "Open in agent view" for everything else.
      return null;
  }
}

/** The contextual Ask June chat: a fixed side panel next to the meeting note,
 * mirroring the agent artifact panel's attach mechanics (sibling card on the
 * window background; the main card slides left via the :has() margin in
 * app.css). The conversation itself is a real Hermes session scoped to the
 * note — see useNoteChat. */
export function NoteChatPanel({
  note,
  chat,
  recordingActive,
  creditActionsDisabledReason,
  renderFundingNotice,
  onClose,
  onOpenInAgent,
}: {
  note: { id: string; title: string };
  /** The note's chat session, owned by App so it keeps running when the panel
   * closes (background work + toolbar working dot). See useNoteChat. */
  chat: NoteChat;
  /** True while a meeting/dictation recording is capturing. The Rust side
   * ducks the recording's mic while dictation listens (so a dictated question
   * never lands in the note); this only tunes the tooltip to say so. */
  recordingActive?: boolean;
  creditActionsDisabledReason?: string;
  /** App owns the account and billing action; the composer owns the active
   * session model and picker. */
  renderFundingNotice?: (context: TextFundingNoticeContext) => ReactNode;
  onClose: () => void;
  onOpenInAgent: (sessionId: string | undefined) => void;
}) {
  const {
    turns,
    working,
    loading,
    error,
    storedSessionId,
    modelSelection,
    appliedHermesModelId,
    submit,
    retryUpstreamFailure,
    stop,
    setSessionModel,
  } = chat;
  // Block escalation only during the pure first-send race — the session is
  // being created and there's no id to hand off yet. Once an id exists the
  // agent view resolves the conversation by it, so opening is always safe.
  const escalationPending = working && !storedSessionId;
  const [entered, setEntered] = useState(false);
  const [draftEmpty, setDraftEmpty] = useState(true);
  const [attachments, setAttachments] = useState<NoteChatAttachment[]>([]);
  const [importing, setImporting] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  useSyncExternalStore(
    upstreamProviderRecoveryStore.subscribe,
    upstreamProviderRecoveryStore.getVersion,
    upstreamProviderRecoveryStore.getVersion,
  );
  const upstreamFailureRecoveryIds = useMemo(() => upstreamProviderRecoveryIds(turns), [turns]);
  const composerRef = useRef<ComposerEditorHandle | null>(null);
  const draftRef = useRef("");
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  async function handleUpstreamFailureRetry(turnId: string) {
    const recoveryId = upstreamFailureRecoveryIds.get(turnId);
    if (
      !storedSessionId ||
      !recoveryId ||
      !upstreamProviderRecoveryStore.reserve(storedSessionId, recoveryId)
    ) {
      return;
    }
    const accepted = await retryUpstreamFailure().catch(() => false);
    if (accepted) return;
    upstreamProviderRecoveryStore.release(storedSessionId, recoveryId);
  }

  // The "+" picker routes through the same bridge import as the workspace so
  // the agent always gets a real, readable workspace path. One file at a
  // time, interleaving read and upload, mirroring the workspace's batching.
  async function pickAttachments() {
    try {
      const selected = await openFileDialog({ multiple: true, title: "Attach files" });
      if (!selected) return;
      const paths = (Array.isArray(selected) ? selected : [selected])
        .map((path) => path.trim())
        .filter(Boolean)
        .slice(0, 8);
      if (!paths.length) return;
      setImporting(true);
      setComposerError(null);
      try {
        for (const path of paths) {
          const file = await importHermesBridgeFile(path);
          setAttachments((current) => [
            ...current,
            {
              ...file,
              id: `${file.path}:${Date.now()}:${Math.random().toString(36)}`,
              attach: attachmentStateFrom(file),
            },
          ]);
        }
      } finally {
        setImporting(false);
      }
    } catch (err) {
      setComposerError(messageFromError(err));
    }
  }

  // Focus the composer, then toggle the dictation helper's listening state —
  // the same command the hotkey path sends. The helper records, shows the
  // HUD, and pastes the transcription into the focused field (the composer).
  async function startDictation() {
    if (creditActionsDisabledReason) {
      setComposerError(creditActionsDisabledReason);
      return;
    }
    composerRef.current?.focus();
    try {
      await dictationHelperCommand({ type: "toggle_listening", shortcut: "Dictation" });
    } catch (err) {
      setComposerError(messageFromError(err));
    }
  }

  // Model picking: the exact trigger + popover the agent composer uses,
  // loaded from the same catalog. Selection routes through the hook (applied
  // at session.create or as a session-scoped switch before the next message).
  const [models, setModels] = useState<VeniceModelDto[]>([]);
  const [localGeneration, setLocalGeneration] = useState<LocalGenerationSettingsDto>({
    baseUrl: "",
    modelId: "",
    apiKey: "",
  });
  const [modelId, setModelId] = useState("");
  const [costQuality, setCostQualityState] = useState<number | undefined>();
  // Mirrors the saved Venice API key's presence so the model popover can show
  // its Auto billing note (Auto meters June credits, never the key).
  const [veniceApiKeyConfigured, setVeniceApiKeyConfigured] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelFlyout, setModelFlyout] = useState<ComposerModelFlyout>(null);
  const [modelSearch, setModelSearch] = useState("");
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelPopoverRef = useRef<HTMLDivElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const modelSelectionRef = useRef(modelSelection);
  const appliedHermesModelIdRef = useRef(appliedHermesModelId);
  const storedSessionIdRef = useRef(storedSessionId);
  const generationSelectionSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const generationSelectionIntentRevisionRef = useRef(0);
  const localEnableConfirmArmedForRef = useRef<string | null>(null);
  modelSelectionRef.current = modelSelection;
  appliedHermesModelIdRef.current = appliedHermesModelId;
  storedSessionIdRef.current = storedSessionId;
  useEffect(() => {
    let stale = false;
    void (async () => {
      const [settings, catalog] = await Promise.all([
        providerModelSettings(),
        listVeniceModels("generation"),
      ]);
      if (stale) return;
      const local = settings.settings.localGeneration ?? {
        baseUrl: "",
        modelId: "",
        apiKey: "",
      };
      setLocalGeneration(local);
      setVeniceApiKeyConfigured(settings.settings.veniceApiKeyConfigured);
      setModels(withLocalGenerationOption(catalog.models, local));
      const fallbackModelId =
        settings.settings.generationProvider === "local" && local.modelId.trim()
          ? localGenerationOptionId(local.modelId)
          : settings.settings.generationModel || catalog.selectedModel;
      const initialSelection = modelSelectionRef.current ??
        selectionForAppliedHermesModel(appliedHermesModelIdRef.current, local) ?? {
          modelId: fallbackModelId,
          ...(fallbackModelId === AUTO_MODEL_ID && settings.settings.costQuality !== undefined
            ? { costQuality: settings.settings.costQuality }
            : {}),
        };
      setModelId(initialSelection.modelId);
      setCostQualityState(
        initialSelection.modelId === AUTO_MODEL_ID
          ? (initialSelection.costQuality ?? settings.settings.costQuality)
          : settings.settings.costQuality,
      );
      if (!modelSelectionRef.current && !storedSessionId) setSessionModel(initialSelection);
    })().catch(() => {
      // No catalog (bridge down, browser preview): the picker simply hides.
    });
    return () => {
      stale = true;
    };
  }, [setSessionModel, storedSessionId]);

  // The hook owns the durable queued/applied choice. Reflect note switches and
  // changes made while an agent run is active without consulting the mutable
  // app-wide default.
  useEffect(() => {
    const displayedSelection =
      modelSelection ?? selectionForAppliedHermesModel(appliedHermesModelId, localGeneration);
    if (!displayedSelection) return;
    setModelId(displayedSelection.modelId);
    if (
      displayedSelection.modelId === AUTO_MODEL_ID &&
      displayedSelection.costQuality !== undefined
    ) {
      setCostQualityState(displayedSelection.costQuality);
    }
  }, [appliedHermesModelId, localGeneration, modelSelection]);
  const model = modelId
    ? models.some((candidate) => candidate.id === modelId)
      ? selectedModel(models, modelId)
      : (unavailableLocalGenerationOption(modelId) ?? selectedModel(models, modelId))
    : undefined;
  const resolvedTextModel = models.find((candidate) => candidate.id === modelId);
  const textFundingContext: TextFundingModelContext = {
    activeModelId: modelId || undefined,
    activeModel: resolvedTextModel,
    veniceApiKeyConfigured,
  };
  const textActionsDisabledReason = shouldBlockTextOnFunding(
    Boolean(creditActionsDisabledReason),
    textFundingContext,
  )
    ? creditActionsDisabledReason
    : undefined;

  function saveGenerationSelection(write: () => Promise<unknown>): Promise<void> {
    const save = generationSelectionSaveChainRef.current.then(async () => {
      await write();
    });
    generationSelectionSaveChainRef.current = save.catch(() => undefined);
    return save;
  }

  async function selectModel(nextModelId: string, nextCostQuality?: number) {
    try {
      if (nextModelId.startsWith(LOCAL_GENERATION_OPTION_ID_PREFIX)) {
        const baseUrl = localGeneration.baseUrl.trim();
        if (!isLoopbackUrl(baseUrl)) {
          if (localEnableConfirmArmedForRef.current !== baseUrl) {
            localEnableConfirmArmedForRef.current = baseUrl;
            setComposerError(
              "This endpoint is not on this machine. Requests will leave your device. Select the local model again to confirm.",
            );
            setModelOpen(false);
            return;
          }
        }
      }
      localEnableConfirmArmedForRef.current = null;
      const selectedCostQuality =
        nextModelId === AUTO_MODEL_ID ? (nextCostQuality ?? costQuality) : undefined;
      const selection: SessionModelSelection = {
        modelId: nextModelId,
        ...(selectedCostQuality !== undefined ? { costQuality: selectedCostQuality } : {}),
      };
      const previousSelection: SessionModelSelection = {
        modelId,
        ...(modelId === AUTO_MODEL_ID && costQuality !== undefined ? { costQuality } : {}),
      };
      const previousCostQuality = costQuality;
      setModelId(nextModelId);
      if (selectedCostQuality !== undefined) setCostQualityState(selectedCostQuality);
      setSessionModel(selection);
      setModelOpen(false);
      setComposerError(null);
      // Before the first session.create returns there is no stored id yet, but
      // a picker change already belongs to this chat's following agent run.
      // Keep it session-local instead of mutating unrelated future sessions.
      if (storedSessionId || chat.submissionPending) return;

      const intentRevision = ++generationSelectionIntentRevisionRef.current;
      try {
        await saveGenerationSelection(async () => {
          if (nextModelId.startsWith(LOCAL_GENERATION_OPTION_ID_PREFIX)) {
            await setLocalGenerationEnabled(true);
            return;
          }
          if (selectedCostQuality !== undefined) {
            await setCostQuality(selectedCostQuality);
          }
          await setVeniceModel("generation", nextModelId);
        });
        if (generationSelectionIntentRevisionRef.current === intentRevision) {
          dispatchProviderModelSettingsChanged({
            mode: "generation",
            modelId: nextModelId,
          });
        }
      } catch (err) {
        if (generationSelectionIntentRevisionRef.current === intentRevision) {
          if (!storedSessionIdRef.current) {
            setModelId(previousSelection.modelId);
            setCostQualityState(previousCostQuality);
            setSessionModel(previousSelection);
          }
          setComposerError(messageFromError(err));
        }
      }
    } catch (err) {
      setComposerError(messageFromError(err));
    }
  }

  useEffect(() => {
    if (!modelOpen) return;
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (modelPopoverRef.current?.contains(target)) return;
      if (modelTriggerRef.current?.contains(target)) return;
      // The hover detail cards are portaled to document.body, so a click inside
      // one (its "Show more" toggle) lands outside the popover — treat it as in.
      if (target instanceof Element && target.closest(".agent-composer-model-hovercard")) return;
      setModelOpen(false);
    }
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [modelOpen]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Esc walks back one layer at a time: model menu, then the panel. A
      // draft in progress blocks the final close — it must not eat the words.
      if (modelOpen) {
        setModelOpen(false);
        return;
      }
      if (draftRef.current.trim()) return;
      onCloseRef.current();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [modelOpen]);

  // Restore the remembered width once per mount; the var lives on .app-shell
  // because the main card's margin and the editor footer consume it too.
  useEffect(() => {
    const shell = panelRef.current?.closest(".app-shell");
    if (!(shell instanceof HTMLElement)) return;
    const stored = Number.parseInt(window.localStorage.getItem(NOTE_CHAT_WIDTH_KEY) ?? "", 10);
    if (Number.isFinite(stored)) {
      shell.style.setProperty("--note-chat-w", `${clampNoteChatWidth(stored)}px`);
    }
  }, []);

  // Drag-resize from the panel's left edge, mirroring the files panel: the
  // var tracks the cursor with transitions suppressed (data-note-chat-resizing)
  // and the final width persists on release.
  const startResize = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const shell = event.currentTarget.closest(".app-shell");
    const startWidth = panelRef.current?.offsetWidth;
    if (!(shell instanceof HTMLElement) || !startWidth) return;
    shell.setAttribute("data-note-chat-resizing", "true");
    const startX = event.clientX;
    const onMove = (move: PointerEvent) => {
      const next = clampNoteChatWidth(startWidth + (startX - move.clientX));
      shell.style.setProperty("--note-chat-w", `${next}px`);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      shell.removeAttribute("data-note-chat-resizing");
      const finalWidth = panelRef.current?.offsetWidth;
      if (finalWidth) {
        window.localStorage.setItem(NOTE_CHAT_WIDTH_KEY, `${finalWidth}`);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }, []);

  // Edge fades on the thread (same trick as the files panel): the bar has no
  // divider, so the top fade is what signals content scrolled up behind it.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const fade = useScrollFade(scrollerRef);

  // Keep the newest turn in view as the conversation grows or streams.
  const lastTurn = turns.at(-1);
  const lastTurnSize = lastTurn?.parts.reduce(
    (size, part) => size + ("text" in part ? part.text.length : 0),
    0,
  );
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    fade.update();
  }, [turns.length, lastTurnSize, working, fade.update]);

  async function handleSend(text: string) {
    if (working || importing || textActionsDisabledReason) return;
    setComposerError(null);
    const accepted = await submit(text, attachments);
    if (accepted) {
      draftRef.current = "";
      setDraftEmpty(true);
      setAttachments([]);
      composerRef.current?.clear();
      composerRef.current?.focus();
    }
  }

  // A preset drops its prompt into the composer for the person to send or
  // edit — never auto-submits — matching the main session view's presets so a
  // click always lands in the box before it costs anything.
  function prefillPreset(preset: NotePreset) {
    draftRef.current = preset.prompt;
    setDraftEmpty(false);
    composerRef.current?.setContent(preset.prompt, null, { focus: true });
  }

  const streamingVisibly =
    lastTurn?.role === "assistant" &&
    lastTurn.status === "running" &&
    lastTurn.parts.some((part) => part.type === "text" && part.text.trim());
  const runningTool =
    lastTurn?.status === "running"
      ? [...lastTurn.parts]
          .reverse()
          .find((part) => part.type === "tool" && part.status === "running")
      : undefined;

  return (
    <>
      <div
        className="note-chat-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Ask June panel"
        onPointerDown={startResize}
      />
      <aside
        ref={panelRef}
        className="note-chat-panel"
        aria-label="Ask June about this note"
        data-entered={entered || undefined}
        onAnimationEnd={(event) => {
          if (event.animationName === "note-chat-panel-in") setEntered(true);
        }}
      >
        <header className="note-chat-bar">
          <h2 className="note-chat-bar-title">Ask June</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Open in agent view"
            title={escalationPending ? "Finishing up…" : "Open in agent view"}
            disabled={escalationPending}
            onClick={() => onOpenInAgent(storedSessionId)}
          >
            <IconArrowUpRight size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close Ask June"
            title="Close"
            onClick={onClose}
          >
            <IconCrossMedium size={15} />
          </button>
        </header>
        <div ref={scrollerRef} className="note-chat-scroll scroll-fade-mask" {...fade.props}>
          {turns.length === 0 && !loading ? (
            <div className="note-chat-empty">
              <p className="note-chat-empty-lead">
                Ask about this note: what was said, what it means, or how to reshape it.
              </p>
              <div className="note-chat-suggestions">
                {NOTE_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    className="agent-hero-chip"
                    disabled={working}
                    onClick={() => prefillPreset(preset)}
                  >
                    <span className="agent-hero-chip-icon" aria-hidden>
                      {preset.icon}
                    </span>
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="note-chat-thread">
              {turns.map((turn) =>
                turn.role === "user" ? (
                  <div key={turn.id} className="note-chat-turn-user">
                    {userTurnText(turn)}
                  </div>
                ) : (
                  <div key={turn.id} className="note-chat-turn-assistant">
                    {turn.parts.map((part, index) =>
                      assistantPartNode(part, index, turnContainsMediaStructure(turn), {
                        attempted: storedSessionId
                          ? upstreamProviderRecoveryStore.attempted(
                              storedSessionId,
                              upstreamFailureRecoveryIds.get(turn.id) ?? "",
                            )
                          : false,
                        disabled: working || chat.submissionPending,
                        onRetry: () => void handleUpstreamFailureRetry(turn.id),
                      }),
                    )}
                  </div>
                ),
              )}
              {working && !streamingVisibly ? (
                <div className="note-chat-working">
                  {runningTool && "name" in runningTool ? runningTool.name : "Thinking…"}
                </div>
              ) : null}
            </div>
          )}
          {error || composerError ? (
            <div className="note-chat-error" role="alert">
              {error ?? composerError}
            </div>
          ) : null}
        </div>
        <footer className="note-chat-composer">
          {textActionsDisabledReason
            ? (renderFundingNotice?.({
                ...textFundingContext,
                onSelectVeniceModel: () => {
                  setModelFlyout(null);
                  setModelSearch("");
                  setModelOpen(true);
                },
              }) ?? (
                <p className="agent-composer-notice" role="status">
                  {textActionsDisabledReason}
                </p>
              ))
            : null}
          {/* The actual chatbox: the agent composer's box/attach/toolbar/model/
           * send classes, wired to the panel's session. */}
          <div className="agent-composer-box">
            {attachments.length ? (
              <div className="agent-composer-attachments">
                {attachments.map((attachment) => (
                  <span
                    key={attachment.id}
                    className="agent-attachment-chip"
                    data-attach-status={attachment.attach.status}
                    title={attachment.attach.error ?? attachment.name}
                  >
                    {attachment.previewDataUrl ? (
                      <img src={attachment.previewDataUrl} alt="" aria-hidden="true" />
                    ) : (
                      <FileTypeIcon name={attachment.name} size={14} />
                    )}
                    <span className="agent-attachment-name">{attachment.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${attachment.name}`}
                      onClick={() =>
                        setAttachments((current) =>
                          current.filter((item) => item.id !== attachment.id),
                        )
                      }
                    >
                      <IconCrossSmall size={12} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <ComposerEditor
              ref={composerRef}
              placeholder={importing ? "Attaching file…" : "Ask about this note"}
              onChange={(text) => {
                draftRef.current = text;
                setDraftEmpty(!text.trim());
              }}
              onSubmit={() => void handleSend(draftRef.current)}
            />
            <div className="agent-composer-toolbar">
              <button
                type="button"
                className="agent-composer-attach"
                aria-label="Attach files"
                title="Attach files"
                onClick={() => void pickAttachments()}
              >
                <IconPlusMedium size={18} />
              </button>
              <div className="agent-composer-actions">
                <ComposerModelPicker
                  open={modelOpen}
                  model={model}
                  detail={
                    model?.id === AUTO_MODEL_ID ? autoPillDesignation(costQuality) : undefined
                  }
                  triggerRef={modelTriggerRef}
                  onToggleOpen={() => {
                    setModelFlyout(null);
                    setModelSearch("");
                    setModelOpen((open) => !open);
                  }}
                />
                <button
                  type="button"
                  className="agent-composer-mic"
                  aria-label="Dictate"
                  title={
                    creditActionsDisabledReason ??
                    (recordingActive
                      ? "Dictate a question (kept out of the recording)"
                      : "Start dictation")
                  }
                  disabled={Boolean(creditActionsDisabledReason)}
                  onClick={() => void startDictation()}
                >
                  <IconMicrophone size={18} />
                </button>
                {working ? (
                  <button
                    type="button"
                    className="agent-composer-stop"
                    aria-label="Stop June"
                    title="Stop June"
                    onClick={stop}
                  >
                    <IconStop size={16} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="agent-composer-send"
                    aria-label="Send message"
                    disabled={
                      Boolean(textActionsDisabledReason) ||
                      importing ||
                      (draftEmpty && !attachments.length)
                    }
                    onClick={() => void handleSend(draftRef.current)}
                  >
                    <IconArrowUp size={18} />
                  </button>
                )}
              </div>
            </div>
          </div>
          {modelOpen ? (
            <ComposerModelPopover
              flyout={modelFlyout}
              model={model}
              options={modelOptions(models, model?.id ?? "")}
              costQuality={costQuality}
              search={modelSearch}
              popoverRef={modelPopoverRef}
              searchRef={modelSearchRef}
              veniceApiKeyConfigured={veniceApiKeyConfigured}
              onFlyoutChange={setModelFlyout}
              onSearchChange={setModelSearch}
              onSelect={(nextModelId, nextCostQuality) =>
                void selectModel(nextModelId, nextCostQuality)
              }
            />
          ) : null}
        </footer>
      </aside>
    </>
  );
}
