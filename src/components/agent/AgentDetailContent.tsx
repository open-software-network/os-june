import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconStopCircle } from "central-icons/IconStopCircle";
import { memo, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { sessionUnrestricted } from "../../lib/agent-session-modes";
import type { AgentChatTurn } from "../../lib/agent-chat-runtime";
import { hermesTraceBuffer } from "../../lib/hermes-trace-buffer";
import { upstreamProviderRecoveryStore } from "../../lib/upstream-provider-recovery";
import {
  formatTurnDiagnostics,
  getTurnDiagnostics,
  getTurnDiagnosticsVersion,
  subscribeTurnDiagnostics,
} from "../../lib/turn-diagnostics";
import { useExperimentalFlags } from "../../lib/experimental-flags";
import { AgentThinking } from "./AgentThinking";
import type { RenderAgentDetailContentDependencies } from "./AgentDetailContent-types";
import { HermesTracePanel } from "./HermesTracePanel";
import { UnsupportedEventNotice } from "./UnsupportedEventNotice";
import { setGalleryDesired } from "./agent-dev-tools";
import { ActivityIndicator } from "./agent-workspace-support";
import { AgentChatTurnRow, type AgentChatTurnRowProps } from "./chat-turns/AgentChatTurnRow";
import { AgentResponseGallery } from "./chat-turns/TranscriptViews";
import { PrivacyModeBadge } from "./composer/ModelPicker";

type RenderTurn = (turn: AgentChatTurn) => JSX.Element;

function useStableEvent<Arguments extends unknown[], Result>(
  callback: (...args: Arguments) => Result,
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback((...args: Arguments) => callbackRef.current(...args), []);
}

function useStableSettledTurns(turns: AgentChatTurn[]) {
  const previousRef = useRef<AgentChatTurn[]>([]);
  const next = turns.slice(0, -1);
  const previous = previousRef.current;
  if (previous.length === next.length && previous.every((turn, index) => turn === next[index])) {
    return previous;
  }
  previousRef.current = next;
  return next;
}

function attemptedRecoveryIdsAtVersion(
  sessionId: string | undefined,
  recoveryIds: Map<string, string>,
  _version: number,
) {
  return new Set(
    [...recoveryIds.values()].filter((recoveryId) =>
      upstreamProviderRecoveryStore.attempted(sessionId ?? "", recoveryId),
    ),
  );
}

/**
 * Owns the transcript tail throughout its running-to-complete transition, so
 * streaming state never invalidates the settled-row element list and the text
 * reveal keeps the same component instance while it finishes fading.
 */
const StreamingAgentChatTurn = memo(function StreamingAgentChatTurn({
  renderTurn,
  turn,
}: {
  renderTurn: RenderTurn;
  turn: AgentChatTurn;
}) {
  return renderTurn(turn);
});

/** Dev-only per-turn diagnostics line (JUN-436). Subscribes to the
 * turn-diagnostics store and renders a concise timing/token summary after the
 * last completed turn. Only renders when the experimental flag is on, the
 * session has diagnostics, and the session is not actively running. */
function TurnDiagnosticsLine({
  sessionId,
  sessionRunning,
}: {
  sessionId: string;
  sessionRunning: boolean;
}) {
  useSyncExternalStore(
    subscribeTurnDiagnostics,
    getTurnDiagnosticsVersion,
    getTurnDiagnosticsVersion,
  );
  if (sessionRunning) return null;
  const diagnostics = getTurnDiagnostics(sessionId);
  if (!diagnostics) return null;
  return (
    <div className="agent-turn-diagnostics" role="status" aria-label="Turn diagnostics">
      {formatTurnDiagnostics(diagnostics)}
    </div>
  );
}

function AgentChatTranscriptRows({
  renderTurn,
  turns,
}: {
  renderTurn: RenderTurn;
  turns: AgentChatTurn[];
}) {
  const settledTurns = useStableSettledTurns(turns);
  const settledRows = useMemo(
    () => settledTurns.map((turn) => renderTurn(turn)),
    [renderTurn, settledTurns],
  );
  const streamingTurn = turns.at(-1);

  return (
    <>
      {settledRows}
      {streamingTurn ? (
        <StreamingAgentChatTurn
          key={streamingTurn.id}
          turn={streamingTurn}
          renderTurn={renderTurn}
        />
      ) : null}
    </>
  );
}

export function AgentDetailContent(dependencies: RenderAgentDetailContentDependencies) {
  const {
    activeThinkingKey,
    approvalSubmitting,
    branchFromMessage,
    branchingMessageId,
    browserAccessEnabled,
    browserAccessSubmitting,
    browserApprovalCards,
    cancelTask,
    clarifySubmitting,
    cliAccessEnabled,
    cliAccessSubmitting,
    creditActionsDisabledReason,
    downloadArtifact,
    downloadGeneratedImage,
    downloadGeneratedVideo,
    enableBrowserAccessFromChat,
    enableCliAccessFromChat,
    fundingTier,
    galleryErrors,
    gallerySections,
    generationPrivacyBadge,
    handleTopUp,
    hermesTurns,
    listRef,
    newSessionMode,
    openArtifact,
    openGeneratedImage,
    pinTranscriptAfterVisibleReveal,
    rawTraceSession,
    respondToApproval,
    respondToClarify,
    respondToSecret,
    respondToSudo,
    retryImageSlashTurn,
    retryTask,
    retryUpstreamProviderFailure,
    retryVideoSlashTurn,
    secretSubmitting,
    selectedHermesSessionId,
    selectedTask,
    setRawTraceSession,
    setThinkingOpen,
    stopHermesSession,
    sudoSubmitting,
    taskTurns,
    thinkingOpen,
    topUpLabel,
    turnArtifacts,
    unsupportedNotice,
    upstreamFailureRecoveryIds,
    waitingSessionIds,
    workingSessionIds,
    workingTaskIds,
  } = dependencies;

  const stableBranchFromMessage = useStableEvent(branchFromMessage);
  const stableCancelTask = useStableEvent(cancelTask);
  const stableDownloadArtifact = useStableEvent(downloadArtifact);
  const stableDownloadGeneratedImage = useStableEvent(downloadGeneratedImage);
  const stableDownloadGeneratedVideo = useStableEvent(downloadGeneratedVideo);
  const stableEnableBrowserAccess = useStableEvent(enableBrowserAccessFromChat);
  const stableEnableCliAccess = useStableEvent(enableCliAccessFromChat);
  const stableHandleTopUp = useStableEvent(handleTopUp);
  const stableOpenArtifact = useStableEvent(openArtifact);
  const stableOpenGeneratedImage = useStableEvent(openGeneratedImage);
  const stableRespondToApproval = useStableEvent(respondToApproval);
  const stableRespondToClarify = useStableEvent(respondToClarify);
  const stableRespondToSecret = useStableEvent(respondToSecret);
  const stableRespondToSudo = useStableEvent(respondToSudo);
  const stableRetryImageSlashTurn = useStableEvent(retryImageSlashTurn);
  const stableRetryTask = useStableEvent(retryTask);
  const stableRetryUpstreamProviderFailure = useStableEvent(retryUpstreamProviderFailure);
  const stableRetryVideoSlashTurn = useStableEvent(retryVideoSlashTurn);
  const stableStopHermesSession = useStableEvent(stopHermesSession);
  const upstreamFailureRecoveryIdsRef = useRef(upstreamFailureRecoveryIds);
  upstreamFailureRecoveryIdsRef.current = upstreamFailureRecoveryIds;

  const onEnableCliAccess = useCallback(
    () => void stableEnableCliAccess(),
    [stableEnableCliAccess],
  );
  const onEnableBrowserAccess = useCallback(
    () => void stableEnableBrowserAccess(),
    [stableEnableBrowserAccess],
  );
  const cliAccess = useMemo<NonNullable<AgentChatTurnRowProps["cliAccess"]>>(
    () => ({
      enabled: cliAccessEnabled,
      submitting: cliAccessSubmitting,
      onEnable: onEnableCliAccess,
    }),
    [cliAccessEnabled, cliAccessSubmitting, onEnableCliAccess],
  );
  const browserAccess = useMemo<NonNullable<AgentChatTurnRowProps["browserAccess"]>>(
    () => ({
      enabled: browserAccessEnabled,
      submitting: browserAccessSubmitting,
      onEnable: onEnableBrowserAccess,
    }),
    [browserAccessEnabled, browserAccessSubmitting, onEnableBrowserAccess],
  );

  const onHermesRetryImage = useCallback<NonNullable<AgentChatTurnRowProps["onRetryImage"]>>(
    (assistantTurnId, part) => {
      if (!selectedHermesSessionId) return;
      void stableRetryImageSlashTurn(selectedHermesSessionId, assistantTurnId, part);
    },
    [selectedHermesSessionId, stableRetryImageSlashTurn],
  );
  const onHermesRetryVideo = useCallback<NonNullable<AgentChatTurnRowProps["onRetryVideo"]>>(
    (assistantTurnId, part) => {
      if (!selectedHermesSessionId) return;
      void stableRetryVideoSlashTurn(selectedHermesSessionId, assistantTurnId, part);
    },
    [selectedHermesSessionId, stableRetryVideoSlashTurn],
  );
  const onHermesRetryUpstreamFailure = useCallback<
    NonNullable<AgentChatTurnRowProps["onRetryUpstreamFailure"]>
  >(
    (turnId) =>
      void stableRetryUpstreamProviderFailure(
        selectedHermesSessionId,
        upstreamFailureRecoveryIdsRef.current.get(turnId),
      ),
    [selectedHermesSessionId, stableRetryUpstreamProviderFailure],
  );
  const onHermesApproval = useCallback<AgentChatTurnRowProps["onApproval"]>(
    (part, choice) => {
      if (!selectedHermesSessionId) return;
      void stableRespondToApproval(
        selectedHermesSessionId,
        part.sessionId ?? selectedHermesSessionId,
        part.id,
        choice,
        sessionUnrestricted(selectedHermesSessionId),
      );
    },
    [selectedHermesSessionId, stableRespondToApproval],
  );
  const onHermesClarify = useCallback<AgentChatTurnRowProps["onClarify"]>(
    (part, answer) => {
      if (!selectedHermesSessionId) return;
      void stableRespondToClarify(
        selectedHermesSessionId,
        part.id,
        answer,
        sessionUnrestricted(selectedHermesSessionId),
      );
    },
    [selectedHermesSessionId, stableRespondToClarify],
  );
  const onHermesSudo = useCallback<AgentChatTurnRowProps["onSudo"]>(
    (part, approved) => {
      if (!selectedHermesSessionId) return;
      void stableRespondToSudo(
        selectedHermesSessionId,
        part.sessionId ?? selectedHermesSessionId,
        part.id,
        approved,
        part.mode,
        sessionUnrestricted(selectedHermesSessionId),
      );
    },
    [selectedHermesSessionId, stableRespondToSudo],
  );
  const onHermesSecret = useCallback<AgentChatTurnRowProps["onSecret"]>(
    (part, value) => {
      if (!selectedHermesSessionId) return;
      void stableRespondToSecret(
        selectedHermesSessionId,
        part.sessionId ?? selectedHermesSessionId,
        part.id,
        value,
        sessionUnrestricted(selectedHermesSessionId),
      );
    },
    [selectedHermesSessionId, stableRespondToSecret],
  );
  const onHermesBranch = useCallback<NonNullable<AgentChatTurnRowProps["onBranch"]>>(
    (messageId, sessionId) => {
      if (!selectedHermesSessionId) return;
      void stableBranchFromMessage(
        sessionId ?? selectedHermesSessionId,
        messageId,
        selectedHermesSessionId,
      );
    },
    [selectedHermesSessionId, stableBranchFromMessage],
  );
  const upstreamFailureRetryDisabled = Boolean(
    selectedHermesSessionId &&
      (workingSessionIds.has(selectedHermesSessionId) ||
        waitingSessionIds.has(selectedHermesSessionId)),
  );
  // AgentWorkspace subscribes to this store; the version makes the cached row
  // elements refresh when a one-shot retry is reserved or released.
  const upstreamFailureRecoveryVersion = upstreamProviderRecoveryStore.getVersion();
  const attemptedUpstreamFailureRecoveryIds = useMemo(
    () =>
      attemptedRecoveryIdsAtVersion(
        selectedHermesSessionId,
        upstreamFailureRecoveryIds,
        upstreamFailureRecoveryVersion,
      ),
    [selectedHermesSessionId, upstreamFailureRecoveryIds, upstreamFailureRecoveryVersion],
  );
  const renderHermesTurn = useCallback<RenderTurn>(
    (turn) => {
      const recoveryId = upstreamFailureRecoveryIdsRef.current.get(turn.id) ?? "";
      return (
        <AgentChatTurnRow
          key={turn.id}
          turn={turn}
          activeThinkingKey={activeThinkingKey}
          artifacts={turnArtifacts.get(turn.id)}
          approvalSubmitting={approvalSubmitting}
          clarifySubmitting={clarifySubmitting}
          sudoSubmitting={sudoSubmitting}
          secretSubmitting={secretSubmitting}
          cliAccess={cliAccess}
          browserAccess={browserAccess}
          thinkingOpen={thinkingOpen}
          onThinkingOpenChange={setThinkingOpen}
          onDownloadArtifact={stableDownloadArtifact}
          onOpenArtifact={stableOpenArtifact}
          onDownloadImage={stableDownloadGeneratedImage}
          onOpenImage={stableOpenGeneratedImage}
          onRetryImage={onHermesRetryImage}
          onDownloadVideo={stableDownloadGeneratedVideo}
          onRetryVideo={onHermesRetryVideo}
          onRetryUpstreamFailure={onHermesRetryUpstreamFailure}
          upstreamFailureRetryAttempted={attemptedUpstreamFailureRecoveryIds.has(recoveryId)}
          upstreamFailureRetryDisabled={upstreamFailureRetryDisabled}
          creditActionsDisabledReason={creditActionsDisabledReason}
          onApproval={onHermesApproval}
          onTopUp={stableHandleTopUp}
          topUpLabel={topUpLabel}
          fundingTier={fundingTier}
          onClarify={onHermesClarify}
          onSudo={onHermesSudo}
          onSecret={onHermesSecret}
          onBranch={onHermesBranch}
          branchingMessageId={branchingMessageId}
          onVisibleMarkdownChange={pinTranscriptAfterVisibleReveal}
        />
      );
    },
    [
      activeThinkingKey,
      approvalSubmitting,
      attemptedUpstreamFailureRecoveryIds,
      branchingMessageId,
      browserAccess,
      clarifySubmitting,
      cliAccess,
      creditActionsDisabledReason,
      fundingTier,
      onHermesApproval,
      onHermesBranch,
      onHermesClarify,
      onHermesRetryImage,
      onHermesRetryUpstreamFailure,
      onHermesRetryVideo,
      onHermesSecret,
      onHermesSudo,
      pinTranscriptAfterVisibleReveal,
      secretSubmitting,
      setThinkingOpen,
      stableDownloadArtifact,
      stableDownloadGeneratedImage,
      stableDownloadGeneratedVideo,
      stableHandleTopUp,
      stableOpenArtifact,
      stableOpenGeneratedImage,
      sudoSubmitting,
      thinkingOpen,
      topUpLabel,
      turnArtifacts,
      upstreamFailureRetryDisabled,
    ],
  );

  const taskId = selectedTask?.id;
  const taskHermesSessionId = selectedTask?.hermesSessionId;
  const onTaskApproval = useCallback<AgentChatTurnRowProps["onApproval"]>(
    (part, choice) => {
      if (!taskId) return;
      const sessionId = part.sessionId ?? taskHermesSessionId;
      if (!sessionId) return;
      void stableRespondToApproval(
        taskId,
        sessionId,
        part.id,
        choice,
        sessionUnrestricted(taskHermesSessionId),
      );
    },
    [stableRespondToApproval, taskHermesSessionId, taskId],
  );
  const onTaskClarify = useCallback<AgentChatTurnRowProps["onClarify"]>(
    (part, answer) => {
      if (!taskId) return;
      void stableRespondToClarify(
        taskId,
        part.id,
        answer,
        sessionUnrestricted(taskHermesSessionId),
      );
    },
    [stableRespondToClarify, taskHermesSessionId, taskId],
  );
  const onTaskSudo = useCallback<AgentChatTurnRowProps["onSudo"]>(
    (part, approved) => {
      if (!taskId) return;
      const sessionId = part.sessionId ?? taskHermesSessionId;
      if (!sessionId) return;
      void stableRespondToSudo(
        taskId,
        sessionId,
        part.id,
        approved,
        part.mode,
        sessionUnrestricted(taskHermesSessionId),
      );
    },
    [stableRespondToSudo, taskHermesSessionId, taskId],
  );
  const onTaskSecret = useCallback<AgentChatTurnRowProps["onSecret"]>(
    (part, value) => {
      if (!taskId) return;
      const sessionId = part.sessionId ?? taskHermesSessionId;
      if (!sessionId) return;
      void stableRespondToSecret(
        taskId,
        sessionId,
        part.id,
        value,
        sessionUnrestricted(taskHermesSessionId),
      );
    },
    [stableRespondToSecret, taskHermesSessionId, taskId],
  );
  const renderTaskTurn = useCallback<RenderTurn>(
    (turn) => (
      <AgentChatTurnRow
        key={turn.id}
        turn={turn}
        activeThinkingKey={activeThinkingKey}
        artifacts={turnArtifacts.get(turn.id)}
        approvalSubmitting={approvalSubmitting}
        clarifySubmitting={clarifySubmitting}
        sudoSubmitting={sudoSubmitting}
        secretSubmitting={secretSubmitting}
        cliAccess={cliAccess}
        browserAccess={browserAccess}
        thinkingOpen={thinkingOpen}
        onThinkingOpenChange={setThinkingOpen}
        onDownloadArtifact={stableDownloadArtifact}
        onOpenArtifact={stableOpenArtifact}
        creditActionsDisabledReason={creditActionsDisabledReason}
        onTopUp={stableHandleTopUp}
        topUpLabel={topUpLabel}
        fundingTier={fundingTier}
        onVisibleMarkdownChange={pinTranscriptAfterVisibleReveal}
        onApproval={onTaskApproval}
        onClarify={onTaskClarify}
        onSudo={onTaskSudo}
        onSecret={onTaskSecret}
      />
    ),
    [
      activeThinkingKey,
      approvalSubmitting,
      browserAccess,
      clarifySubmitting,
      cliAccess,
      creditActionsDisabledReason,
      fundingTier,
      onTaskApproval,
      onTaskClarify,
      onTaskSecret,
      onTaskSudo,
      pinTranscriptAfterVisibleReveal,
      secretSubmitting,
      setThinkingOpen,
      stableDownloadArtifact,
      stableHandleTopUp,
      stableOpenArtifact,
      sudoSubmitting,
      thinkingOpen,
      topUpLabel,
      turnArtifacts,
    ],
  );

  const closeGallery = useCallback(() => setGalleryDesired(false), []);
  const experimentalFlags = useExperimentalFlags();
  const turnDiagnosticsEnabled = experimentalFlags.turn_diagnostics;
  const openRawTrace = useCallback(
    (sessionId: string) => setRawTraceSession(sessionId),
    [setRawTraceSession],
  );
  const closeRawTrace = useCallback(() => setRawTraceSession(undefined), [setRawTraceSession]);
  const stopSelectedHermesSession = useCallback(() => {
    if (selectedHermesSessionId) void stableStopHermesSession(selectedHermesSessionId);
  }, [selectedHermesSessionId, stableStopHermesSession]);
  const reportSelectedHermesTrace = useCallback(() => {
    // The sanitized, secret-free trace bundle for this session is the payload
    // an issue report should attach. The report dialog is not wired yet, so
    // keep logging this dev-only affordance.
    if (import.meta.env.DEV && selectedHermesSessionId) {
      // biome-ignore lint/suspicious/noConsole: dev-only trace-bundle diagnostic
      console.debug(
        "[hermes] report issue trace bundle",
        hermesTraceBuffer.exportSanitizedTrace(selectedHermesSessionId),
      );
    }
  }, [selectedHermesSessionId]);
  const cancelSelectedTask = useCallback(() => {
    if (taskId) void stableCancelTask(taskId);
  }, [stableCancelTask, taskId]);
  const retrySelectedTask = useCallback(() => {
    if (taskId) void stableRetryTask(taskId);
  }, [stableRetryTask, taskId]);

  return gallerySections ? (
    <AgentResponseGallery
      sections={gallerySections}
      errors={galleryErrors}
      fundingTier={fundingTier}
      onClose={closeGallery}
    />
  ) : !newSessionMode && selectedHermesSessionId ? (
    <div ref={listRef} className="agent-timeline">
      <UnsupportedEventNotice
        notice={unsupportedNotice}
        // Dev/debug context gates the raw-trace affordance. Reuse the same DEV
        // signal feature 01 used; feature 15 can swap in a richer debug toggle.
        debugEnabled={import.meta.env.DEV}
        onOpenRawTrace={openRawTrace}
        onStopSession={stopSelectedHermesSession}
        onReportIssue={reportSelectedHermesTrace}
      />
      <HermesTracePanel
        buffer={hermesTraceBuffer}
        open={rawTraceSession !== undefined}
        sessionId={rawTraceSession}
        onClose={closeRawTrace}
      />
      <AgentChatTranscriptRows turns={hermesTurns} renderTurn={renderHermesTurn} />
      {turnDiagnosticsEnabled && selectedHermesSessionId ? (
        <TurnDiagnosticsLine
          sessionId={selectedHermesSessionId}
          sessionRunning={workingSessionIds.has(selectedHermesSessionId)}
        />
      ) : null}
      {browserApprovalCards}
      <AgentThinking
        visible={
          workingSessionIds.has(selectedHermesSessionId) && hermesTurns.at(-1)?.role === "user"
        }
      />
    </div>
  ) : !newSessionMode && selectedTask ? (
    <>
      <header className="agent-detail-header">
        <div className="agent-detail-title">
          <ActivityIndicator active={workingTaskIds.has(selectedTask.id)} large />
          <div className="agent-detail-heading">
            <h2>{selectedTask.title}</h2>
            <PrivacyModeBadge badge={generationPrivacyBadge} />
          </div>
        </div>
        <div className="agent-actions">
          {selectedTask.status !== "cancelled" && selectedTask.status !== "completed" ? (
            <button
              type="button"
              className="agent-icon-button"
              aria-label="Cancel task"
              onClick={cancelSelectedTask}
            >
              <IconStopCircle size={15} />
            </button>
          ) : null}
          {selectedTask.status === "failed" || selectedTask.status === "paused" ? (
            <button
              type="button"
              className="agent-icon-button"
              aria-label="Retry task"
              onClick={retrySelectedTask}
            >
              <IconArrowRotateClockwise size={15} />
            </button>
          ) : null}
        </div>
      </header>
      <div ref={listRef} className="agent-timeline">
        <AgentChatTranscriptRows turns={taskTurns} renderTurn={renderTaskTurn} />
        {browserApprovalCards}
        <AgentThinking
          visible={workingTaskIds.has(selectedTask.id) && taskTurns.at(-1)?.role === "user"}
        />
      </div>
    </>
  ) : null;
}
