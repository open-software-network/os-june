import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  hermesAgentCliAccess,
  type HermesMessagingPlatformInfo,
  type HermesSkillInfo,
  type HermesToolsetInfo,
  type LocalGenerationSettingsDto,
  type VeniceModelDto,
} from "../../lib/tauri";
import { type JuneHermesEvent } from "../../lib/hermes-control-plane";
import { useScrollFade } from "../../lib/use-scroll-fade";
import { hermesActivityStore } from "../../lib/hermes-activity-store";
import { useUsagePanelDemo } from "../../lib/usage-panel-demo";
import { type HermesSessionDispatchReservation } from "../../lib/hermes-session-dispatch-mutex";
import {
  readSessionModelSelections,
  subscribeSessionModelSelections,
  type SessionModelSelectionMap,
} from "../../lib/hermes-session-model-selection";
import {
  loadThinkingLevel,
  loadSessionThinkingLevels,
  type ThinkingLevel,
} from "../../lib/thinking-level";
import { type ModelPickerFlyout } from "../settings/ModelPickerPopover";
import { type AgentApprovalChoice } from "../../lib/agent-chat-runtime";
import type { AgentAttachment } from "./agent-workspace-models";
import { upstreamProviderRecoveryStore } from "../../lib/upstream-provider-recovery";
import {
  type PendingAttachmentPreparation,
  type PendingSteer,
  type QueuedAttachmentFollowUp,
} from "./composer/follow-up-queue";
import { type AgentArtifact, type AgentArtifactPanelState } from "./chat-turns/AgentArtifactPanel";
import {
  projectAgentActivityLevels,
  type AgentActivityLevelProjection,
} from "./session-state-helpers";
import type { UseAgentRuntimeStateDependencies } from "./use-agent-runtime-state-types";

export function useAgentRuntimeState(dependencies: UseAgentRuntimeStateDependencies) {
  const { continuity, selectedHermesSessionId } = dependencies;

  const pendingFastPathImagesRef = useRef<Record<string, AgentAttachment[]>>({});
  // Per-session ordering for message fetches: the sequence handed out at
  // fetch start, and the highest sequence whose response was applied. See
  // listSessionMessagesOrdered.
  const sessionMessagesFetchSeqRef = useRef<Map<string, number>>(new Map());
  const sessionMessagesAppliedSeqRef = useRef<Map<string, number>>(new Map());
  const [hermesSessionsLoading, setHermesSessionsLoading] = useState(false);
  const [liveEvents, setLiveEvents] = useState<Record<string, JuneHermesEvent[]>>(
    () => continuity?.liveEvents ?? {},
  );
  const [thinkingOpenByKey, setThinkingOpenByKey] = useState<Record<string, boolean>>({});
  const [workingTaskIds, setWorkingTaskIds] = useState<Set<string>>(() => new Set());
  const activityStoreVersion = useSyncExternalStore(
    hermesActivityStore.subscribe,
    hermesActivityStore.getVersion,
    hermesActivityStore.getVersion,
  );
  const activityRecords = useMemo(
    () => hermesActivityStore.getRecords(),
    // `activityStoreVersion` is the change signal; the read returns live rows.
    [activityStoreVersion],
  );
  const previousActivityLevelsRef = useRef<AgentActivityLevelProjection | undefined>(undefined);
  const activityLevels = useMemo(() => {
    const next = projectAgentActivityLevels(activityRecords, previousActivityLevelsRef.current);
    previousActivityLevelsRef.current = next;
    return next;
  }, [activityRecords]);
  const { toolCallSessionIds, waitingSessionIds, workingSessionIds } = activityLevels;
  const workingSessionIdsRef = useRef<Set<string>>(workingSessionIds);
  const toolCallSessionIdsRef = useRef<Set<string>>(toolCallSessionIds);
  // Steers we've sent that Hermes may not have delivered yet. Hermes only
  // injects a steer into the next tool result, so a no-tool turn drops it; we
  // track the text and resend it as a follow-up on completion when no tool
  // consumed it (cleared on a tool.complete or a clean terminal).
  const pendingSteerBySessionIdRef = useRef<Record<string, PendingSteer[]>>({});
  // Reservations owned by composer work that has not yet transferred into a
  // durable follow-up row. Unmount cancels these so a suspended consent or
  // preparation promise cannot wedge the module-global session FIFO.
  const activeComposerDispatchReservationsRef = useRef(
    new Map<HermesSessionDispatchReservation, string>(),
  );
  const invalidatedComposerDispatchReservationsRef = useRef(
    new WeakSet<HermesSessionDispatchReservation>(),
  );
  // Steer cards: injected instructions tacked to the top of the composer while
  // June works. They are a read-only presentation of instructions already
  // submitted to Hermes, not a cancellable staging queue. The pending ref
  // retains delivery tracking until the turn ends or is stopped.
  const [steerCardsBySessionId, setSteerCardsBySessionId] = useState<
    Record<string, { id: string; text: string }[]>
  >({});
  const steerCardSeqRef = useRef(0);
  const [queuedAttachmentFollowUps, setQueuedAttachmentFollowUps] = useState<
    Record<string, QueuedAttachmentFollowUp[]>
  >(() =>
    Object.fromEntries(
      Object.entries(continuity?.queuedAttachmentFollowUps ?? {}).map(([sessionId, items]) => [
        sessionId,
        items.map((item) =>
          item.status === "sending"
            ? {
                ...item,
                dispatchReservation: undefined,
                status: "failed" as const,
                error: "Delivery was interrupted. Try again.",
              }
            : item,
        ),
      ]),
    ),
  );
  const queuedAttachmentFollowUpsRef = useRef(queuedAttachmentFollowUps);
  // Attachment preparation can finish out of Send order. A completed agent
  // run must not advance a materialized later row while an earlier accepted
  // Send is still preparing off-queue.
  const pendingAttachmentPreparationsRef = useRef<
    Record<string, Map<number, PendingAttachmentPreparation>>
  >({});
  const completedAgentRunAwaitingAttachmentPreparationRef = useRef(new Set<string>());
  const computerUseRunLeasesRef = useRef(new Map<string, Set<string>>());
  const [upNextDemoFollowUpsBySessionId, setUpNextDemoFollowUpsBySessionId] = useState<
    Record<string, QueuedAttachmentFollowUp[]>
  >({});
  const queuedAttachmentFollowUpSeqRef = useRef(
    Object.values(continuity?.queuedAttachmentFollowUps ?? {}).reduce(
      (highest, items) =>
        items.reduce((itemHighest, item) => {
          const sequence = Number(item.id.match(/^attachment-follow-up-(\d+)$/)?.[1] ?? 0);
          return Math.max(itemHighest, sequence);
        }, highest),
      0,
    ),
  );
  const composerDispatchOrderRef = useRef(
    Object.values(continuity?.queuedAttachmentFollowUps ?? {}).reduce(
      (highest, items) =>
        items.reduce(
          (itemHighest, item) => Math.max(itemHighest, item.dispatchOrder ?? 0),
          highest,
        ),
      0,
    ),
  );
  // Completion is observable through the live gateway and both message-refresh
  // paths. Only one of them may advance queued follow-ups for a finished agent
  // run. Gateway listeners carry a unique source token: duplicate terminal
  // frames from one listener are ignored, while a terminal frame from the
  // follow-up being submitted is remembered until the current queue mutation
  // finishes.
  const continuingCompletedAgentRunSourcesRef = useRef(new Map<string, symbol | undefined>());
  const pendingCompletedAgentRunSourcesRef = useRef(new Map<string, symbol>());
  // The steer queue shows all rows by default; the header collapses the list
  // to itself. Reset (back open) per session below.
  const [steerQueueOpen, setSteerQueueOpen] = useState(true);
  // Fade for the expanded stack's capped scroller (spec/scroll-fade.md).
  const steerCardsListRef = useRef<HTMLDivElement | null>(null);
  const steerCardsFade = useScrollFade(steerCardsListRef);
  const waitingSessionIdsRef = useRef<Set<string>>(waitingSessionIds);
  const [runtimeSessionIds, setRuntimeSessionIds] = useState<Record<string, string>>(
    () => continuity?.runtimeSessionIds ?? {},
  );
  const runtimeSessionIdsRef = useRef(runtimeSessionIds);
  // Consecutive runtime-reconcile polls in which a locally-working session was
  // absent from a reachable snapshot or the mode itself was unreachable.
  // Separate streaks preserve the registration-race tolerance while allowing
  // faster native recovery from a silently stalled gateway.
  const workingReconcileStreaksRef = useRef(
    new Map<string, { missing: number; unreachable: number }>(),
  );
  const [stoppingSessionIds, setStoppingSessionIds] = useState<ReadonlySet<string>>(new Set());
  const [skills, setSkills] = useState<HermesSkillInfo[] | null>(null);
  const skillCommandsLoadRef = useRef<Promise<HermesSkillInfo[]> | null>(null);
  const [toolsets, setToolsets] = useState<HermesToolsetInfo[] | null>(null);
  const [messagingPlatforms, setMessagingPlatforms] = useState<
    HermesMessagingPlatformInfo[] | null
  >(null);
  // The text-model catalog backs both the global default for new chats and
  // each chat's stored model. A selection missing from the catalog still
  // shows as a name-only stub so the pill never goes blank while configured.
  const [defaultGenerationModelId, setDefaultGenerationModelId] = useState("");
  const [generationCostQuality, setGenerationCostQuality] = useState<number | undefined>();
  // Mirrors the saved Venice API key's presence so the model picker's Auto
  // section can show its billing note (Auto meters June credits, never the
  // key). Refreshed with every provider-settings read.
  const [veniceApiKeyConfigured, setVeniceApiKeyConfigured] = useState(false);
  const veniceApiKeyConfiguredRef = useRef(false);
  // Preference saves from the picker's drill-in: writes are chained so they
  // persist in click order, and versioned so only the newest call's outcome
  // touches the UI (mirrors Settings' saveCostQuality discipline). Rollback
  // targets the last CONFIRMED value (persisted read or successful save) —
  // never an optimistic value a still-in-flight click painted.
  const costQualitySaveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const latestCostQualitySaveRef = useRef(0);
  const confirmedCostQualityRef = useRef<number | undefined>(undefined);
  const defaultGenerationModelIdRef = useRef("");
  const generationCostQualityRef = useRef<number | undefined>();
  const generationSelectionIntentRevisionRef = useRef(0);
  const generationSelectionSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  // Existing sessions own a durable desired selection. A picker change writes
  // this map synchronously but never touches the live Hermes agent; submit
  // snapshots one revision and applies it only before the next prompt. Keeping
  // applied entries also preserves Auto's per-session designation across app
  // restarts, which the Hermes session row cannot represent on its own.
  const [sessionModelSelections, setSessionModelSelections] = useState<SessionModelSelectionMap>(
    readSessionModelSelections,
  );
  const sessionModelSelectionsRef = useRef(sessionModelSelections);
  useEffect(
    () =>
      subscribeSessionModelSelections((next) => {
        sessionModelSelectionsRef.current = next;
        setSessionModelSelections(next);
      }),
    [],
  );
  const [generationModels, setGenerationModels] = useState<VeniceModelDto[]>([]);
  const generationModelsRef = useRef<VeniceModelDto[]>([]);
  // Bring-your-own local text generation. When the global provider is "local"
  // the model catalog carries a synthetic "Local: <id>" option and the pill
  // resolves to it, so the composer never shows a raw local id or silently
  // reverts the app to metered remote generation. Kept as refs too because the
  // async provider-selection handler reads the latest values.
  const [localGeneration, setLocalGeneration] = useState<LocalGenerationSettingsDto>({
    baseUrl: "",
    modelId: "",
    apiKey: "",
  });
  const localGenerationRef = useRef(localGeneration);
  // Two-step confirm for enabling a NON-loopback local endpoint from the
  // composer (requests would leave the device, so no path may enable one
  // silently — Settings has the same invariant with its "Enable anyway"
  // affordance). Holds the exact base URL the warning was shown for: a second
  // selection only proceeds while the saved URL still matches, so editing the
  // endpoint in Settings re-arms the warning. Loopback endpoints never arm it.
  const localEnableConfirmArmedForRef = useRef<string | null>(null);
  const [composerModelOpen, setComposerModelOpen] = useState(false);
  // Whether the open picker was summoned by the /model slash command; it
  // drives search focus on open and Escape returning focus to the draft.
  const [composerModelFromSlash, setComposerModelFromSlash] = useState(false);
  const composerModelRootSearchRef = useRef<HTMLInputElement>(null);
  // The popover's root-layer query, independent of the All models flyout's
  // `modelSearch`: L2's box filters only its catalog list, and typing there
  // never flips the root layer into results mode.
  const [modelRootSearch, setModelRootSearch] = useState("");
  const [composerModelFlyout, setComposerModelFlyout] = useState<ModelPickerFlyout>(null);
  const [modelSearch, setModelSearch] = useState("");
  const composerModelTriggerRef = useRef<HTMLButtonElement>(null);
  const composerModelPopoverRef = useRef<HTMLDivElement>(null);
  const composerModelSearchRef = useRef<HTMLInputElement>(null);
  // Thinking level: how much June reasons before answering. The stored draft
  // seeds new sessions (session.create's reasoning_effort). The efforts map
  // records each session's OWN level — its creation pin, a pick made while
  // the session was open, or the effort its live runtime last reported via
  // session.info — persisted in localStorage so it survives relaunch; the
  // composer shows a session's own level, never the machine-wide draft of
  // whatever chat was retuned last. The applied map remembers which effort
  // the session's CURRENT runtime is known to be at (acked config.set, the
  // create pin, or a session.info report) so a turn only re-asserts when
  // the runtime or the level actually changed (config.set writes the profile
  // config each call, so it is not something to fire blindly on every send).
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() => loadThinkingLevel());
  const thinkingLevelRef = useRef(thinkingLevel);
  const sessionThinkingEffortsRef = useRef<Record<string, ThinkingLevel> | null>(null);
  // Lazy one-time load of the persisted per-session efforts (a ref, not
  // state: async send/pick closures must read the latest map, not a render
  // snapshot).
  function sessionThinkingEfforts(): Record<string, ThinkingLevel> {
    if (!sessionThinkingEffortsRef.current) {
      sessionThinkingEffortsRef.current = loadSessionThinkingLevels();
    }
    return sessionThinkingEffortsRef.current;
  }
  const sessionThinkingAppliedRef = useRef<Record<string, { runtimeId: string; effort: string }>>(
    {},
  );
  // Attestation walkthrough URL served by the backend (same page as Settings
  // → About → Verify server); the privacy badge links to it when known.
  const [capabilityQuery, setCapabilityQuery] = useState("");
  const [capabilityLoading, setCapabilityLoading] = useState(false);
  const [skillCommandLoading, setSkillCommandLoading] = useState(false);
  const [capabilitySaving, setCapabilitySaving] = useState<string | null>(null);
  const [selectedMessagingPlatformId, setSelectedMessagingPlatformId] = useState<string>();
  const [messagingEnvEdits, setMessagingEnvEdits] = useState<Record<string, string>>({});
  const [artifactPanel, setArtifactPanel] = useState<AgentArtifactPanelState | null>(null);
  // The session whose usage/cost panel is open, or null. Self-contained for
  // feature 09; feature 11's activity drawer will later host the same panel.
  const [usagePanelSessionId, setUsagePanelSessionId] = useState<string | null>(null);
  // Dev-only: __usageDemo("half") parks the usage overlay in a fixture state
  // regardless of the real session. Null in production because the command is
  // never registered. See lib/usage-panel-demo.ts.
  const usageDemo = useUsagePanelDemo();
  // The session whose context-compaction dialog is open, or null (feature 08).
  const [compactSessionId, setCompactSessionId] = useState<string | null>(null);
  // Session currently being shared through the private-sharing dialog
  // (JUN-308); only ever the selected session, set from the session bar menu.
  const [shareSessionId, setShareSessionId] = useState<string | null>(null);
  const [sessionShareUrl, setSessionShareUrl] = useState<string | null>(null);
  // The share payload snapshots the selected session's visible transcript,
  // so the dialog must never outlive its selection.
  useEffect(() => {
    setShareSessionId(null);
    setSessionShareUrl(null);
  }, [selectedHermesSessionId]);
  // Dev-only sample files seeded by window.__agentFiles — surfaced alongside
  // the conversation's own artifacts so the viewer can be exercised at will.
  const [devArtifacts, setDevArtifacts] = useState<AgentArtifact[]>([]);
  const [approvalSubmitting, setApprovalSubmitting] = useState<
    Partial<Record<string, AgentApprovalChoice>>
  >({});
  // Synchronous transport state for disconnect reconciliation. React state can
  // lag behind the socket close callback by one render, so it cannot tell us
  // reliably whether Hermes may already have accepted a response.
  const approvalResponsesInFlightRef = useRef(new Map<string, AgentApprovalChoice>());
  const [clarifySubmitting, setClarifySubmitting] = useState<Record<string, string>>({});
  // Shared across chat surfaces and component remounts for this app process.
  // reserve() closes the duplicate-click gap before React commits a render.
  useSyncExternalStore(
    upstreamProviderRecoveryStore.subscribe,
    upstreamProviderRecoveryStore.getVersion,
    upstreamProviderRecoveryStore.getVersion,
  );
  // Sudo records which choice (approve/deny) is in flight per request id;
  // secret records only that a submit is in flight (NEVER the value).
  const [sudoSubmitting, setSudoSubmitting] = useState<Record<string, "approve" | "deny">>({});
  const [secretSubmitting, setSecretSubmitting] = useState<Record<string, true>>({});
  // Whether "Agent CLI access" (Settings, Agent tab) is on — drives the
  // in-chat request card June can raise via its soul token. undefined until
  // the stored value loads, so a card never flashes the wrong state.
  const [cliAccessEnabled, setCliAccessEnabled] = useState<boolean>();
  const [cliAccessSubmitting, setCliAccessSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    hermesAgentCliAccess()
      .then((status) => {
        if (!cancelled) setCliAccessEnabled(status.enabled);
      })
      .catch(() => {
        // Unknown stays unknown; the card keeps its actionable default.
        if (!cancelled) setCliAccessEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Whether "Browser use" (Settings, Agent tab) is on — the stored Browser
  // access grant behind June's in-chat request card. Same lifecycle as the
  // CLI access state above.
  const [browserAccessEnabled, setBrowserAccessEnabled] = useState<boolean>();
  const [browserAccessSubmitting, setBrowserAccessSubmitting] = useState(false);

  return {
    pendingFastPathImagesRef,
    sessionMessagesFetchSeqRef,
    sessionMessagesAppliedSeqRef,
    hermesSessionsLoading,
    setHermesSessionsLoading,
    liveEvents,
    setLiveEvents,
    thinkingOpenByKey,
    setThinkingOpenByKey,
    workingTaskIds,
    setWorkingTaskIds,
    activityStoreVersion,
    activityRecords,
    toolCallSessionIds,
    waitingSessionIds,
    workingSessionIds,
    workingSessionIdsRef,
    toolCallSessionIdsRef,
    pendingSteerBySessionIdRef,
    activeComposerDispatchReservationsRef,
    invalidatedComposerDispatchReservationsRef,
    steerCardsBySessionId,
    setSteerCardsBySessionId,
    steerCardSeqRef,
    queuedAttachmentFollowUps,
    setQueuedAttachmentFollowUps,
    queuedAttachmentFollowUpsRef,
    pendingAttachmentPreparationsRef,
    completedAgentRunAwaitingAttachmentPreparationRef,
    computerUseRunLeasesRef,
    upNextDemoFollowUpsBySessionId,
    setUpNextDemoFollowUpsBySessionId,
    queuedAttachmentFollowUpSeqRef,
    composerDispatchOrderRef,
    continuingCompletedAgentRunSourcesRef,
    pendingCompletedAgentRunSourcesRef,
    steerQueueOpen,
    setSteerQueueOpen,
    steerCardsListRef,
    steerCardsFade,
    waitingSessionIdsRef,
    runtimeSessionIds,
    setRuntimeSessionIds,
    runtimeSessionIdsRef,
    workingReconcileStreaksRef,
    stoppingSessionIds,
    setStoppingSessionIds,
    skills,
    setSkills,
    skillCommandsLoadRef,
    toolsets,
    setToolsets,
    messagingPlatforms,
    setMessagingPlatforms,
    defaultGenerationModelId,
    setDefaultGenerationModelId,
    generationCostQuality,
    setGenerationCostQuality,
    veniceApiKeyConfigured,
    setVeniceApiKeyConfigured,
    veniceApiKeyConfiguredRef,
    costQualitySaveChainRef,
    latestCostQualitySaveRef,
    confirmedCostQualityRef,
    defaultGenerationModelIdRef,
    generationCostQualityRef,
    generationSelectionIntentRevisionRef,
    generationSelectionSaveChainRef,
    sessionModelSelections,
    setSessionModelSelections,
    sessionModelSelectionsRef,
    generationModels,
    setGenerationModels,
    generationModelsRef,
    localGeneration,
    setLocalGeneration,
    localGenerationRef,
    localEnableConfirmArmedForRef,
    composerModelOpen,
    setComposerModelOpen,
    composerModelFromSlash,
    setComposerModelFromSlash,
    composerModelRootSearchRef,
    modelRootSearch,
    setModelRootSearch,
    composerModelFlyout,
    setComposerModelFlyout,
    modelSearch,
    setModelSearch,
    composerModelTriggerRef,
    composerModelPopoverRef,
    composerModelSearchRef,
    thinkingLevel,
    setThinkingLevel,
    thinkingLevelRef,
    sessionThinkingEffortsRef,
    sessionThinkingEfforts,
    sessionThinkingAppliedRef,
    setCapabilityLoading,
    skillCommandLoading,
    setSkillCommandLoading,
    setCapabilitySaving,
    setSelectedMessagingPlatformId,
    messagingEnvEdits,
    setMessagingEnvEdits,
    artifactPanel,
    setArtifactPanel,
    usagePanelSessionId,
    setUsagePanelSessionId,
    usageDemo,
    compactSessionId,
    setCompactSessionId,
    shareSessionId,
    setShareSessionId,
    sessionShareUrl,
    setSessionShareUrl,
    devArtifacts,
    setDevArtifacts,
    approvalSubmitting,
    setApprovalSubmitting,
    approvalResponsesInFlightRef,
    clarifySubmitting,
    setClarifySubmitting,
    sudoSubmitting,
    setSudoSubmitting,
    secretSubmitting,
    setSecretSubmitting,
    cliAccessEnabled,
    setCliAccessEnabled,
    cliAccessSubmitting,
    setCliAccessSubmitting,
    browserAccessEnabled,
    setBrowserAccessEnabled,
    browserAccessSubmitting,
    setBrowserAccessSubmitting,
  };
}
