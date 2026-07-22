import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconStopCircle } from "central-icons/IconStopCircle";
import { AgentThinking } from "./AgentThinking";
import { hermesTraceBuffer } from "../../lib/hermes-trace-buffer";
import { UnsupportedEventNotice } from "./UnsupportedEventNotice";
import { HermesTracePanel } from "./HermesTracePanel";
import { PrivacyModeBadge } from "./composer/ModelPicker";
import { sessionUnrestricted } from "../../lib/agent-session-modes";
import { upstreamProviderRecoveryStore } from "../../lib/upstream-provider-recovery";
import { setGalleryDesired } from "./agent-dev-tools";
import { AgentResponseGallery } from "./chat-turns/TranscriptViews";
import { AgentChatTurnRow } from "./chat-turns/AgentChatTurnRow";
import { ActivityIndicator } from "./agent-workspace-support";
import type { RenderAgentDetailContentDependencies } from "./AgentDetailContent-types";

export function renderAgentDetailContent(dependencies: RenderAgentDetailContentDependencies) {
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

  return gallerySections ? (
    <AgentResponseGallery
      sections={gallerySections}
      errors={galleryErrors}
      fundingTier={fundingTier}
      onClose={() => setGalleryDesired(false)}
    />
  ) : !newSessionMode && selectedHermesSessionId ? (
    <div ref={listRef} className="agent-timeline">
      <UnsupportedEventNotice
        notice={unsupportedNotice}
        // Dev/debug context gates the raw-trace affordance. Reuse the same DEV
        // signal feature 01 used; feature 15 can swap in a richer debug toggle.
        debugEnabled={import.meta.env.DEV}
        onOpenRawTrace={(sessionId) => {
          // Feature 15: open the dev/debug raw trace panel for this session.
          // The panel itself is dev-gated (renders null in production), so this
          // is inert in shipped builds even if the affordance were reached.
          setRawTraceSession(sessionId);
        }}
        onStopSession={() => void stopHermesSession(selectedHermesSessionId)}
        onReportIssue={() => {
          // The sanitized, secret-free trace bundle for this session is the
          // payload an issue report should attach (payload previews come from
          // `sanitizePayload`). This trace affordance is not wired into the
          // report dialog yet, so keep logging in dev.
          if (import.meta.env.DEV) {
            // biome-ignore lint/suspicious/noConsole: dev-only trace-bundle diagnostic
            console.debug(
              "[hermes] report issue trace bundle",
              hermesTraceBuffer.exportSanitizedTrace(selectedHermesSessionId),
            );
          }
        }}
      />
      <HermesTracePanel
        buffer={hermesTraceBuffer}
        open={rawTraceSession !== undefined}
        sessionId={rawTraceSession}
        onClose={() => setRawTraceSession(undefined)}
      />
      {hermesTurns.map((turn) => (
        <AgentChatTurnRow
          key={turn.id}
          turn={turn}
          activeThinkingKey={activeThinkingKey}
          artifacts={turnArtifacts.get(turn.id)}
          approvalSubmitting={approvalSubmitting}
          clarifySubmitting={clarifySubmitting}
          sudoSubmitting={sudoSubmitting}
          secretSubmitting={secretSubmitting}
          cliAccess={{
            enabled: cliAccessEnabled,
            submitting: cliAccessSubmitting,
            onEnable: () => void enableCliAccessFromChat(),
          }}
          browserAccess={{
            enabled: browserAccessEnabled,
            submitting: browserAccessSubmitting,
            onEnable: () => void enableBrowserAccessFromChat(),
          }}
          thinkingOpen={thinkingOpen}
          onThinkingOpenChange={setThinkingOpen}
          onDownloadArtifact={downloadArtifact}
          onOpenArtifact={openArtifact}
          onDownloadImage={downloadGeneratedImage}
          onOpenImage={openGeneratedImage}
          onRetryImage={(assistantTurnId, part) =>
            void retryImageSlashTurn(selectedHermesSessionId, assistantTurnId, part)
          }
          onDownloadVideo={downloadGeneratedVideo}
          onRetryVideo={(assistantTurnId, part) =>
            void retryVideoSlashTurn(selectedHermesSessionId, assistantTurnId, part)
          }
          onRetryUpstreamFailure={(turnId) =>
            void retryUpstreamProviderFailure(
              selectedHermesSessionId,
              upstreamFailureRecoveryIds.get(turnId),
            )
          }
          upstreamFailureRetryAttempted={upstreamProviderRecoveryStore.attempted(
            selectedHermesSessionId,
            upstreamFailureRecoveryIds.get(turn.id) ?? "",
          )}
          upstreamFailureRetryDisabled={
            workingSessionIds.has(selectedHermesSessionId) ||
            waitingSessionIds.has(selectedHermesSessionId)
          }
          creditActionsDisabledReason={creditActionsDisabledReason}
          onApproval={(part, choice) =>
            void respondToApproval(
              selectedHermesSessionId,
              part.sessionId ?? selectedHermesSessionId,
              part.id,
              choice,
              sessionUnrestricted(selectedHermesSessionId),
            )
          }
          onTopUp={handleTopUp}
          topUpLabel={topUpLabel}
          fundingTier={fundingTier}
          onClarify={(part, answer) =>
            void respondToClarify(
              selectedHermesSessionId,
              part.id,
              answer,
              sessionUnrestricted(selectedHermesSessionId),
            )
          }
          onSudo={(part, approved) =>
            void respondToSudo(
              selectedHermesSessionId,
              part.sessionId ?? selectedHermesSessionId,
              part.id,
              approved,
              part.mode,
              sessionUnrestricted(selectedHermesSessionId),
            )
          }
          onSecret={(part, value) =>
            void respondToSecret(
              selectedHermesSessionId,
              part.sessionId ?? selectedHermesSessionId,
              part.id,
              value,
              sessionUnrestricted(selectedHermesSessionId),
            )
          }
          onBranch={(messageId, sessionId) =>
            void branchFromMessage(
              sessionId ?? selectedHermesSessionId,
              messageId,
              selectedHermesSessionId,
            )
          }
          branchingMessageId={branchingMessageId}
          onVisibleMarkdownChange={pinTranscriptAfterVisibleReveal}
        />
      ))}
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
              onClick={() => void cancelTask(selectedTask.id)}
            >
              <IconStopCircle size={15} />
            </button>
          ) : null}
          {selectedTask.status === "failed" || selectedTask.status === "paused" ? (
            <button
              type="button"
              className="agent-icon-button"
              aria-label="Retry task"
              onClick={() => void retryTask(selectedTask.id)}
            >
              <IconArrowRotateClockwise size={15} />
            </button>
          ) : null}
        </div>
      </header>
      <div ref={listRef} className="agent-timeline">
        {taskTurns.map((turn) => (
          <AgentChatTurnRow
            key={turn.id}
            turn={turn}
            activeThinkingKey={activeThinkingKey}
            artifacts={turnArtifacts.get(turn.id)}
            approvalSubmitting={approvalSubmitting}
            clarifySubmitting={clarifySubmitting}
            sudoSubmitting={sudoSubmitting}
            secretSubmitting={secretSubmitting}
            cliAccess={{
              enabled: cliAccessEnabled,
              submitting: cliAccessSubmitting,
              onEnable: () => void enableCliAccessFromChat(),
            }}
            browserAccess={{
              enabled: browserAccessEnabled,
              submitting: browserAccessSubmitting,
              onEnable: () => void enableBrowserAccessFromChat(),
            }}
            thinkingOpen={thinkingOpen}
            onThinkingOpenChange={setThinkingOpen}
            onDownloadArtifact={downloadArtifact}
            onOpenArtifact={openArtifact}
            creditActionsDisabledReason={creditActionsDisabledReason}
            onTopUp={handleTopUp}
            topUpLabel={topUpLabel}
            fundingTier={fundingTier}
            onVisibleMarkdownChange={pinTranscriptAfterVisibleReveal}
            onApproval={(part, choice) => {
              const sessionId = part.sessionId ?? selectedTask.hermesSessionId;
              if (!sessionId) return;
              void respondToApproval(
                selectedTask.id,
                sessionId,
                part.id,
                choice,
                sessionUnrestricted(selectedTask.hermesSessionId),
              );
            }}
            onClarify={(part, answer) =>
              void respondToClarify(
                selectedTask.id,
                part.id,
                answer,
                sessionUnrestricted(selectedTask.hermesSessionId),
              )
            }
            onSudo={(part, approved) => {
              const sessionId = part.sessionId ?? selectedTask.hermesSessionId;
              if (!sessionId) return;
              void respondToSudo(
                selectedTask.id,
                sessionId,
                part.id,
                approved,
                part.mode,
                sessionUnrestricted(selectedTask.hermesSessionId),
              );
            }}
            onSecret={(part, value) => {
              const sessionId = part.sessionId ?? selectedTask.hermesSessionId;
              if (!sessionId) return;
              void respondToSecret(
                selectedTask.id,
                sessionId,
                part.id,
                value,
                sessionUnrestricted(selectedTask.hermesSessionId),
              );
            }}
          />
        ))}
        {browserApprovalCards}
        <AgentThinking
          visible={workingTaskIds.has(selectedTask.id) && taskTurns.at(-1)?.role === "user"}
        />
      </div>
    </>
  ) : null;
}
