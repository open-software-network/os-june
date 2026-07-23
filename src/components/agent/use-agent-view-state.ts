import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { unsupportedEventStore } from "../../lib/hermes-unsupported-events";
import { hermesActivityStore } from "../../lib/hermes-activity-store";
import { hermesArtifactStore } from "../../lib/hermes-artifact-store";
import { HERMES_SERVER_ERROR_MESSAGE } from "../../lib/errors";
import { attachScrollThumbFade } from "../../lib/scroll-thumb-fade";
import { useComposerMenuDismiss } from "./use-composer-menu-dismiss";
import { advanceHeroGreeting } from "./agent-workspace-config";
import { GATEWAY_CONNECTION_ERROR } from "./agent-workspace-errors";
import { NEW_SESSION_RECOVERY_QUEUE_KEY } from "./agent-session-continuity";
import type { UseAgentViewStateDependencies } from "./use-agent-view-state-types";

export function useAgentViewState(dependencies: UseAgentViewStateDependencies) {
  const {
    activityStoreVersion,
    agentScrollRef,
    attachMenuOpen,
    attachMenuRef,
    attachTriggerRef,
    attachments,
    composerEditorRef,
    composerInSteerStateFor,
    composerModelFlyout,
    composerModelFromSlash,
    composerModelOpen,
    composerModelPopoverRef,
    composerModelRootSearchRef,
    composerModelSearchRef,
    composerModelTriggerRef,
    composerSteerDemo,
    draft,
    errorState,
    fullModeDraftRef,
    gallerySections,
    hermesSessionItems,
    heroGreetingConsumedRef,
    importingFiles,
    modelRootSearch,
    newSessionMode,
    newSessionModeRef,
    queuedAttachmentFollowUps,
    reviewableIssueReports,
    sandboxFirstItemRef,
    sandboxMenuOpen,
    sandboxMenuRef,
    sandboxMenuWasOpenRef,
    sandboxTriggerRef,
    selectedHermesSessionId,
    selectedHermesSessionIdRef,
    selectedHermesSessionIsProvisional,
    selectedTask,
    setActivePanel,
    setAttachMenuOpen,
    setConfirmUnrestricted,
    setComposerModelFlyout,
    setComposerModelOpen,
    setFullModeDraft,
    setHeroGreeting,
    setModelRootSearch,
    setModelSearch,
    setNewSessionMode,
    setSandboxMenuOpen,
    setSelectedHermesSessionId,
    setSelectedTaskId,
    steerCardsBySessionId,
    submitting,
    submittingHermesSessionId,
    submittingIssueReportSessionIds,
    upNextDemoFollowUpsBySessionId,
    visibleAgentWorkspaceError,
    workingSessionIds,
  } = dependencies;

  const heroMode =
    !gallerySections && (newSessionMode || (!selectedHermesSessionId && !selectedTask));
  // Composer steer state: the open session is mid-run (or a send is landing), so
  // the send slot holds Stop and a typed message steers the running turn rather
  // than starting a new one. Drives the steer-send button, the queue-style
  // placeholder, and whether the steer-card stack renders.
  const composerInSteerState = composerInSteerStateFor({
    selectedSessionId: selectedHermesSessionId,
    provisional: selectedHermesSessionIsProvisional,
    working: selectedHermesSessionId ? workingSessionIds.has(selectedHermesSessionId) : false,
    submitting,
    submittingSessionId: submittingHermesSessionId,
    demo: composerSteerDemo,
  });
  const selectedSteerCards = selectedHermesSessionId
    ? (steerCardsBySessionId[selectedHermesSessionId] ?? [])
    : [];
  const visibleFollowUpQueueKey = selectedHermesSessionId
    ? selectedHermesSessionId
    : heroMode
      ? NEW_SESSION_RECOVERY_QUEUE_KEY
      : undefined;
  const selectedQueuedAttachmentFollowUps = visibleFollowUpQueueKey
    ? (queuedAttachmentFollowUps[visibleFollowUpQueueKey] ?? [])
    : [];
  const selectedUpNextDemoFollowUps = selectedHermesSessionId
    ? (upNextDemoFollowUpsBySessionId[selectedHermesSessionId] ?? [])
    : [];
  const selectedFollowUpCount =
    selectedSteerCards.length +
    selectedQueuedAttachmentFollowUps.length +
    selectedUpNextDemoFollowUps.length;
  const visibleErrorState = visibleAgentWorkspaceError(errorState, selectedHermesSessionId);
  const visibleError = visibleErrorState?.message ?? null;
  // The banner offers "Try again" for failures a reconnect-and-reload can clear:
  // our own gateway/bridge connection errors, and a transient Hermes 5xx
  // (HERMES_SERVER_ERROR_MESSAGE, JUN-167). retryGatewayConnection re-runs the
  // session-management loads that produced either.
  const visibleErrorRetryable =
    visibleError != null &&
    (GATEWAY_CONNECTION_ERROR.test(visibleError) || visibleError === HERMES_SERVER_ERROR_MESSAGE);
  // Unsupported Hermes events for the selected session surface a generic,
  // recoverable notice (and sanitized dev details). Subscribing to the store's
  // version re-derives the notice whenever a new unsupported frame lands.
  const unsupportedStoreVersion = useSyncExternalStore(
    unsupportedEventStore.subscribe,
    unsupportedEventStore.getVersion,
    unsupportedEventStore.getVersion,
  );
  const unsupportedNotice = useMemo(
    () => unsupportedEventStore.activeNotice(selectedHermesSessionId),
    // `unsupportedStoreVersion` is the change signal; the lookup reads live state.
    [unsupportedStoreVersion, selectedHermesSessionId],
  );
  // Resolve a session id to its display title for an activity-drawer row,
  // falling back to the raw id when the session isn't in the loaded list
  // (unknown title must never crash or blank the row).
  const titleForPendingSession = useCallback(
    (sessionId: string) => hermesSessionItems.find((session) => session.id === sessionId)?.title,
    [hermesSessionItems],
  );

  // Feature 11: the Agent activity drawer. Subscribing to the activity store's
  // version re-derives the rows whenever any session's activity changes; the
  // drawer is one toggled, top-level surface that shows every session at once.
  //
  // TEMPORARILY HIDDEN: the drawer's "open session" routes by the row's id,
  // which is the ephemeral runtime session id, not the durable stored id, so it
  // opens the wrong session (or none). Until that runtime->stored resolution is
  // fixed, the entry-point toggle is gated off below. The whole feature (drawer,
  // subagent watch, stop, artifacts timeline) stays mounted and tested; flip
  // this flag back to true to restore it.
  const ACTIVITY_DRAWER_ENABLED: false = false;
  const [activityDrawerOpen, setActivityDrawerOpen] = useState(false);
  // The store only knows the count once a session has reported activity; treat a
  // never-touched store as "loading" so the very first paint shows a spinner
  // copy rather than the empty state flashing before any event lands.
  const activityStatus: "loading" | "ready" = activityStoreVersion === 0 ? "loading" : "ready";
  // Open a session from a drawer row: clear new-session mode, switch panel +
  // selection.
  const openSessionFromDrawer = useCallback((sessionId: string) => {
    newSessionModeRef.current = false;
    setNewSessionMode(false);
    setActivePanel("chat");
    selectedHermesSessionIdRef.current = sessionId;
    setSelectedHermesSessionId(sessionId);
    setSelectedTaskId(undefined);
  }, []);
  // Drawer Steer routes into the live steer flow: open the session and focus
  // the main composer, where typing while June works steers the running turn
  // via `steerActiveSession`. The drawer only offers Steer for sessions that
  // are actually steerable (see `canSteerSession` below, aligned with
  // `workingSessionIds`).
  const steerSessionFromDrawer = useCallback(
    (sessionId: string) => {
      openSessionFromDrawer(sessionId);
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focus();
      });
    },
    [openSessionFromDrawer],
  );
  // Count of sessions currently doing work — the toggle badge. Re-derived from
  // the same version signal as the rows.
  const activeAgentCount = useMemo(() => hermesActivityStore.activeCount(), [activityStoreVersion]);
  // Resolve a session's model from the loaded session list for the drawer (no
  // provider is tracked on the session record, so only `model` is supplied;
  // feature 09's usage panel remains the authority for full cost/provider).
  const modelForActivitySession = useCallback(
    (sessionId: string) => {
      const model = hermesSessionItems.find((session) => session.id === sessionId)?.model;
      return model ? { model } : undefined;
    },
    [hermesSessionItems],
  );

  // Feature 14: the per-session artifact timeline behind the drawer's
  // "Artifacts" section. Mirrors the activity-store wiring above: subscribe to
  // the singleton's version, and read the SELECTED session's artifacts (the one
  // the user is viewing) so the section tracks the conversation in front of
  // them. A click adapts the record onto the existing artifact-panel preview
  // flow (see `openTimelineArtifact`).
  const artifactStoreVersion = useSyncExternalStore(
    hermesArtifactStore.subscribe,
    hermesArtifactStore.getVersion,
    hermesArtifactStore.getVersion,
  );
  const timelineArtifacts = useMemo(
    () =>
      selectedHermesSessionId
        ? hermesArtifactStore.getRecordsForSession(selectedHermesSessionId)
        : [],
    // `artifactStoreVersion` is the change signal; the read returns live rows.
    [selectedHermesSessionId, artifactStoreVersion],
  );

  // Feature 15: the dev/debug raw-trace panel. Holds the session it was opened
  // for; `undefined` means closed. Dev-gated where it renders (HermesTracePanel
  // returns null in production), so this state is inert in shipped builds.
  const [rawTraceSession, setRawTraceSession] = useState<string | undefined>(undefined);
  const selectedIssueReportReview = selectedHermesSessionId
    ? reviewableIssueReports[selectedHermesSessionId]
    : undefined;
  const visibleIssueReportReview =
    selectedHermesSessionId && selectedIssueReportReview
      ? {
          report: selectedIssueReportReview,
          sessionId: selectedHermesSessionId,
          submitting: submittingIssueReportSessionIds.has(selectedHermesSessionId),
        }
      : undefined;
  const visibleIssueReportHasUnsentContext = Boolean(
    visibleIssueReportReview && (draft.trim() || attachments.length),
  );
  const visibleIssueReportImportingFiles = Boolean(visibleIssueReportReview && importingFiles);
  // Holds the prior render's heroMode. Read by both the composer auto-grow
  // effect (to skip its glide across a hero transition) and the hero→dock FLIP
  // below (to detect the hero handoff); the FLIP effect, which runs last, is
  // what advances it each render.
  const prevHeroModeRef = useRef(heroMode);

  // A fresh greeting each time the hero is landed on. The state initializer
  // already consumed one for the mount, so the first hero entry (which may be
  // the mount itself) keeps it; later entries advance the cycle. Pre-paint so
  // a re-entry never flashes the previous greeting.
  useLayoutEffect(() => {
    if (!heroMode) return;
    if (!heroGreetingConsumedRef.current) {
      heroGreetingConsumedRef.current = true;
      return;
    }
    setHeroGreeting(advanceHeroGreeting());
  }, [heroMode]);

  // Unrestricted is an opt-in made per new session, so the picker re-arms to
  // sandboxed every time the hero is entered — it never carries over from the
  // last one.
  useEffect(() => {
    if (!heroMode) return;
    fullModeDraftRef.current = false;
    setFullModeDraft(false);
    setSandboxMenuOpen(false);
    setConfirmUnrestricted(false);
  }, [heroMode]);

  // The sandbox picker closes on a click anywhere outside it or Esc, same as
  // the session-bar overflow menu.
  useEffect(() => {
    if (!sandboxMenuOpen) return;
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (sandboxMenuRef.current?.contains(target)) return;
      if (sandboxTriggerRef.current?.contains(target)) return;
      setSandboxMenuOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setSandboxMenuOpen(false);
      }
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [sandboxMenuOpen]);

  // The "+" popover closes on a click outside it or Esc, same as the sandbox
  // picker above.
  useEffect(() => {
    if (!attachMenuOpen) return;
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (attachMenuRef.current?.contains(target)) return;
      if (attachTriggerRef.current?.contains(target)) return;
      setAttachMenuOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setAttachMenuOpen(false);
      }
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [attachMenuOpen]);

  useComposerMenuDismiss({
    composerEditorRef,
    composerModelFlyout,
    composerModelFromSlash,
    composerModelOpen,
    composerModelPopoverRef,
    composerModelTriggerRef,
    modelRootSearch,
    setComposerModelFlyout,
    setComposerModelOpen,
    setModelRootSearch,
    setModelSearch,
  });

  useLayoutEffect(() => {
    if (!composerModelOpen) return;
    if (composerModelFlyout?.kind === "all") {
      composerModelSearchRef.current?.focus();
      return;
    }
    if (composerModelFromSlash) {
      composerModelRootSearchRef.current?.focus();
    }
  }, [composerModelFromSlash, composerModelFlyout, composerModelOpen]);

  // The popover lives outside the composer box (whose overflow:hidden would
  // clip it), so CSS alone can only anchor it to the box, leaving the whole
  // composer height between menu and trigger. Measure the trigger pill on
  // open and pin the menu right above it instead.
  useLayoutEffect(() => {
    if (!composerModelOpen) return;
    function positionPopover() {
      const trigger = composerModelTriggerRef.current;
      const popover = composerModelPopoverRef.current;
      const form = popover?.parentElement;
      if (!trigger || !popover || !form) return;
      const triggerRect = trigger.getBoundingClientRect();
      const formRect = form.getBoundingClientRect();
      popover.style.right = `${formRect.right - triggerRect.right}px`;
      popover.style.bottom = `${formRect.bottom - triggerRect.top + 4}px`;
      // The popover grows upward, so its tall states (Auto on revealing
      // Preference) can reach the titlebar strip. Cap it to the room above
      // the trigger with breathing space; the suggested list is the flex
      // child that shrinks and scrolls (the popover itself must never clip:
      // the drill-in flyouts hang outside its box).
      const titlebarHeight =
        Number.parseFloat(window.getComputedStyle(popover).getPropertyValue("--titlebar-h")) || 0;
      popover.style.maxHeight = `${Math.max(160, triggerRect.top - 4 - titlebarHeight - 12)}px`;
    }
    positionPopover();
    window.addEventListener("resize", positionPopover);
    return () => window.removeEventListener("resize", positionPopover);
  }, [composerModelOpen]);

  useLayoutEffect(() => {
    if (sandboxMenuOpen) {
      sandboxMenuWasOpenRef.current = true;
      sandboxFirstItemRef.current?.focus();
      return;
    }
    if (!sandboxMenuWasOpenRef.current) return;
    sandboxMenuWasOpenRef.current = false;
    sandboxTriggerRef.current?.focus();
  }, [sandboxMenuOpen]);

  // The conversation scroller's thumb fades in with scroll activity and back
  // out when idle (native-overlay feel; see scroll-thumb-fade.ts). The hero
  // intentionally does not mount .agent-scroll, so attach after hero handoff.
  useEffect(() => {
    if (heroMode) return;
    const el = agentScrollRef.current;
    if (!el) return;
    return attachScrollThumbFade(el);
  }, [heroMode]);

  // Same scroll-driven thumb for the steer-queue list — but attached ONLY
  // when the list actually scrolls. The helper also shows on pointer activity,
  // so on a short (non-scrollable) queue merely hovering toggled
  // scrollbar-part paints, flashing an artifact in the card's corner.
  const hasFollowUps = selectedFollowUpCount > 0;

  return {
    heroMode,
    composerInSteerState,
    selectedSteerCards,
    visibleFollowUpQueueKey,
    selectedQueuedAttachmentFollowUps,
    selectedUpNextDemoFollowUps,
    selectedFollowUpCount,
    visibleErrorState,
    visibleError,
    visibleErrorRetryable,
    unsupportedNotice,
    titleForPendingSession,
    ACTIVITY_DRAWER_ENABLED,
    activityDrawerOpen,
    setActivityDrawerOpen,
    activityStatus,
    openSessionFromDrawer,
    steerSessionFromDrawer,
    activeAgentCount,
    modelForActivitySession,
    timelineArtifacts,
    rawTraceSession,
    setRawTraceSession,
    visibleIssueReportReview,
    visibleIssueReportHasUnsentContext,
    visibleIssueReportImportingFiles,
    prevHeroModeRef,
    hasFollowUps,
  };
}
