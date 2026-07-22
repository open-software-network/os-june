import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  osAccountsUpgrade,
  type AgentTaskDto,
  type HermesBridgeStatus,
  type HermesSessionInfo,
  type PendingBrowserApproval,
  browserApprovalRespond,
  browserApprovalsPending,
} from "../../lib/tauri";
import {
  getActiveHermesProfileName,
  useActiveHermesProfile,
} from "../../lib/active-hermes-profile";
import { isTopUpRequiresMaxError, messageFromError } from "../../lib/errors";
import { type ReportCategory } from "./composer/reportCategory";
import { type ReportDialogAttachment } from "./ReportDialog";
import type { AgentAttachment } from "./agent-workspace-models";
import { type AgentPanel } from "./agent-workspace-config";
import type { ImageSafeModeConsentRequest } from "./agent-workspace-models";
import {
  agentWorkspaceErrorStateForMessage,
  type AgentWorkspaceError,
  type AgentWorkspaceErrorOptions,
} from "./agent-workspace-errors";
import {
  readAgentSessionContinuity,
  shouldOpenNewSessionOnMount,
} from "./agent-session-continuity";
import { type ComposerInputSizeWarning } from "./composer/composer-input-helpers";
import { readLastOpenSessionId } from "./session-persistence";
import type { UseAgentCoreStateDependencies } from "./use-agent-core-state-types";

export function useAgentCoreState(dependencies: UseAgentCoreStateDependencies) {
  const { BROWSER_APPROVALS_CHANGED_EVENT, initialSession, initialSessionIdProp, onTopUp } =
    dependencies;

  const initialSessionId = initialSession?.id ?? initialSessionIdProp;
  const activeHermesProfile = useActiveHermesProfile();
  // Read once per mount (lazy initializer): the continuity snapshot the
  // previous mount captured on unmount, if any session was still mid-run.
  const [continuity] = useState(readAgentSessionContinuity);
  const [tasks, setTasks] = useState<AgentTaskDto[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [activePanel, setActivePanel] = useState<AgentPanel>("chat");
  const [draft, setDraft] = useState("");
  // The message's single category tag, mirrored from a restored legacy chip.
  // New reports use the direct popover instead; the server creates the
  // team-facing diagnosis there because no model runs on the client.
  const [category, setCategory] = useState<ReportCategory | null>(null);
  // Live mirror of `draft` for closures (the hero-chip interval) that must read
  // the current value without re-subscribing.
  const draftRef = useRef("");
  const categoryRef = useRef<ReportCategory | null>(null);
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const attachmentsRef = useRef<AgentAttachment[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [importingFiles, setImportingFiles] = useState(false);
  // Reuses the importingFiles busy-gating (set alongside it); this flag only
  // tailors the composer placeholder copy while an image is generating.
  const [generatingImage, setGeneratingImage] = useState(false);
  const [generatingVideo, setGeneratingVideo] = useState(false);
  // Dev-only: window.__composerSteerDemo() parks the composer in the working
  // branch so the stop/steer-send interaction can be iterated without a turn.
  const [composerSteerDemo, setComposerSteerDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // `submitting` gates the whole composer, while this id scopes the immediate
  // Stop visual to the existing session that owns the in-flight send.
  const [submittingHermesSessionId, setSubmittingHermesSessionId] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<AgentWorkspaceError | null>(null);
  const [submittingErrorIssueReport, setSubmittingErrorIssueReport] = useState(false);
  const [composerSizeWarning, setComposerSizeWarning] = useState<ComposerInputSizeWarning | null>(
    null,
  );
  const [imageSafeModeConsentRequest, setImageSafeModeConsentRequest] =
    useState<ImageSafeModeConsentRequest | null>(null);
  const [browserApprovals, setBrowserApprovals] = useState<PendingBrowserApproval[]>([]);
  const [browserApprovalSubmitting, setBrowserApprovalSubmitting] = useState<string>();
  const imageSafeModeConsentRequestRef = useRef<ImageSafeModeConsentRequest | null>(null);
  const composerSizeProceedSignatureRef = useRef<string | null>(null);
  const composerSizeProceedInputSignatureRef = useRef<string | null>(null);
  // Feature 07: the fork lifecycle (creating → branched) is surfaced as a
  // toast — a loading toast while the branch is created, resolving into a
  // "Branched from …" confirmation. See branchFromMessage.
  // Which message a branch is currently in flight for, so its action shows a
  // disabled/working state and double-clicks can't fork twice.
  const [branchingMessageId, setBranchingMessageId] = useState<string | null>(null);
  const branchingMessageIdRef = useRef<string | null>(null);
  const [bridge, setBridge] = useState<HermesBridgeStatus>({
    running: false,
  });
  const [bridgeStarting, setBridgeStarting] = useState(false);
  // Opt-in for the session being composed in the hero: start the runtime
  // without the OS sandbox. Read through a ref inside the async submit path.
  const [fullModeDraft, setFullModeDraft] = useState(false);
  const fullModeDraftRef = useRef(false);
  const [sandboxMenuOpen, setSandboxMenuOpen] = useState(false);
  // Codex-style speed bump: picking Unrestricted from the menu confirms in a
  // dialog before arming, instead of a persistent warning line.
  const [confirmUnrestricted, setConfirmUnrestricted] = useState(false);
  const sandboxTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sandboxMenuRef = useRef<HTMLDivElement | null>(null);
  const sandboxFirstItemRef = useRef<HTMLButtonElement | null>(null);
  const sandboxMenuWasOpenRef = useRef(false);
  // The "+" popover: attach files, reference a note, or open the report form.
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const attachTriggerRef = useRef<HTMLButtonElement | null>(null);
  const attachMenuRef = useRef<HTMLDivElement | null>(null);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [reportDialogCategory, setReportDialogCategory] = useState<ReportCategory>("bug");
  const [reportDialogDescription, setReportDialogDescription] = useState("");
  const [reportDialogAttachments, setReportDialogAttachments] = useState<ReportDialogAttachment[]>(
    [],
  );
  // Bumped when a report is sent; see reportDialogAppendForCurrentGeneration.
  const reportDialogGenerationRef = useRef(0);
  const [hermesSessionItems, setHermesSessionItems] = useState<HermesSessionInfo[]>(() => {
    const restored = continuity?.sessionItems ?? [];
    if (!initialSession) return restored;
    return [initialSession, ...restored.filter((session) => session.id !== initialSession.id)];
  });
  const hermesSessionItemsRef = useRef(hermesSessionItems);
  const profileOwnedSessionIdsRef = useRef<Set<string>>(
    new Set(
      initialSessionId && getActiveHermesProfileName() !== "default" ? [initialSessionId] : [],
    ),
  );
  // False until the first listHermesSessions fetch lands. Until then the
  // items above only hold the mount seed (the clicked session, or nothing),
  // and broadcasting that would wipe the sidebar's already-loaded list.
  const [hermesSessionsHydrated, setHermesSessionsHydrated] = useState(false);
  const hermesSessionsHydratedRef = useRef(false);
  // Mounting without an explicit target restores the last open conversation,
  // so app restarts and dev reloads land the user back in the session they
  // were working in instead of bouncing them to the newest one. A pending
  // new-session marker or saved new-session draft overrides the restore: the
  // marker path prevents a stale selected-session broadcast from dropping
  // pending project context, while the draft path keeps unsent hero text
  // visible after a view switch or reload.
  const [startInNewSessionMode] = useState(
    () => !initialSessionId && shouldOpenNewSessionOnMount(),
  );
  // A last-open id is only a restore candidate until the first profile-scoped
  // session load proves that it belongs to the active profile. Keeping it out
  // of selected state prevents the message loader from reading another
  // profile's conversation during that validation window.
  const restoredHermesSessionIdRef = useRef<string | undefined>(
    initialSessionId || startInNewSessionMode ? undefined : readLastOpenSessionId(),
  );
  const [selectedHermesSessionId, setSelectedHermesSessionId] = useState<string | undefined>(
    initialSessionId,
  );
  const selectedHermesSessionIdRef = useRef<string | undefined>(selectedHermesSessionId);
  const lastAutoSubmittedRef = useRef<{ prompt: string; at: number }>();
  const [newSessionMode, setNewSessionMode] = useState(startInNewSessionMode);
  const setError = useCallback(
    (message: string | null, options: AgentWorkspaceErrorOptions = {}) => {
      if (!message) {
        setErrorState(null);
        return;
      }
      const sessionId =
        options.sessionId === undefined
          ? (selectedHermesSessionIdRef.current ?? null)
          : options.sessionId;
      const nextError = agentWorkspaceErrorStateForMessage(message, sessionId, options.issueReport);
      if (!nextError) {
        return;
      }
      setErrorState(nextError);
    },
    [],
  );

  const refreshBrowserApprovals = useCallback(async () => {
    try {
      setBrowserApprovals(await browserApprovalsPending());
    } catch {
      // The broker may not be configured until a runtime starts. Its change
      // event will retry once an attended action parks.
    }
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void refreshBrowserApprovals();
    const interval = window.setInterval(() => void refreshBrowserApprovals(), 5_000);
    void listen(BROWSER_APPROVALS_CHANGED_EVENT, () => void refreshBrowserApprovals()).then(
      (cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      },
    );
    return () => {
      disposed = true;
      window.clearInterval(interval);
      unlisten?.();
    };
  }, [refreshBrowserApprovals]);

  const respondToBrowserApproval = useCallback(
    async (approvalId: string, approve: boolean, allowSite = false) => {
      setBrowserApprovalSubmitting(approvalId);
      try {
        await browserApprovalRespond({ approvalId, approve, allowSite });
      } catch (error) {
        setError(messageFromError(error));
      } finally {
        setBrowserApprovalSubmitting(undefined);
        void refreshBrowserApprovals();
      }
    },
    [refreshBrowserApprovals, setError],
  );
  const handleTopUp = useCallback(() => {
    const result = onTopUp ? onTopUp() : osAccountsUpgrade();
    void Promise.resolve(result).catch((err: unknown) => {
      // A top-up that the backend gates behind Max must never surface as a raw
      // error; point the user at the upgrade path instead.
      if (isTopUpRequiresMaxError(err)) {
        setError("Upgrade to Max to keep using credits.");
        return;
      }
      setError(messageFromError(err));
    });
  }, [onTopUp, setError]);
  const clearErrorForSession = useCallback((sessionId: string) => {
    setErrorState((current) => (current?.sessionId === sessionId ? null : current));
  }, []);

  return {
    initialSessionId,
    activeHermesProfile,
    continuity,
    tasks,
    setTasks,
    selectedTaskId,
    setSelectedTaskId,
    activePanel,
    setActivePanel,
    draft,
    setDraft,
    category,
    setCategory,
    draftRef,
    categoryRef,
    attachments,
    setAttachments,
    attachmentsRef,
    dropActive,
    setDropActive,
    importingFiles,
    setImportingFiles,
    generatingImage,
    setGeneratingImage,
    generatingVideo,
    setGeneratingVideo,
    composerSteerDemo,
    setComposerSteerDemo,
    loading,
    setLoading,
    submitting,
    setSubmitting,
    submittingHermesSessionId,
    setSubmittingHermesSessionId,
    errorState,
    submittingErrorIssueReport,
    setSubmittingErrorIssueReport,
    composerSizeWarning,
    setComposerSizeWarning,
    imageSafeModeConsentRequest,
    setImageSafeModeConsentRequest,
    browserApprovals,
    browserApprovalSubmitting,
    imageSafeModeConsentRequestRef,
    composerSizeProceedSignatureRef,
    composerSizeProceedInputSignatureRef,
    branchingMessageId,
    setBranchingMessageId,
    branchingMessageIdRef,
    bridge,
    setBridge,
    bridgeStarting,
    setBridgeStarting,
    fullModeDraft,
    setFullModeDraft,
    fullModeDraftRef,
    sandboxMenuOpen,
    setSandboxMenuOpen,
    confirmUnrestricted,
    setConfirmUnrestricted,
    sandboxTriggerRef,
    sandboxMenuRef,
    sandboxFirstItemRef,
    sandboxMenuWasOpenRef,
    attachMenuOpen,
    setAttachMenuOpen,
    attachTriggerRef,
    attachMenuRef,
    reportDialogOpen,
    setReportDialogOpen,
    reportDialogCategory,
    setReportDialogCategory,
    reportDialogDescription,
    setReportDialogDescription,
    reportDialogAttachments,
    setReportDialogAttachments,
    reportDialogGenerationRef,
    hermesSessionItems,
    setHermesSessionItems,
    hermesSessionItemsRef,
    profileOwnedSessionIdsRef,
    hermesSessionsHydrated,
    setHermesSessionsHydrated,
    hermesSessionsHydratedRef,
    restoredHermesSessionIdRef,
    selectedHermesSessionId,
    setSelectedHermesSessionId,
    selectedHermesSessionIdRef,
    lastAutoSubmittedRef,
    newSessionMode,
    setNewSessionMode,
    setError,
    respondToBrowserApproval,
    handleTopUp,
    clearErrorForSession,
  };
}
