import { IconBolt } from "central-icons/IconBolt";
import { createPortal } from "react-dom";
import { type CSSProperties } from "react";
import { openHermesTuiDebug } from "../../lib/tauri";
import { buildSessionPayload } from "../../lib/share-payload";
import { ShareDialog } from "../share/ShareDialog";
import { SessionUsagePanel } from "./SessionUsagePanel";
import { AgentActivityDrawer, AgentArtifactsSection } from "./AgentActivityDrawer";
import { heroPrivacyFootnote } from "./composer/ModelPicker";
import { messageFromError } from "../../lib/errors";
import { ImageSafeModeConsentDialog } from "./ImageSafeModeConsentDialog";
import { VideoSafeModeConsentDialog } from "./VideoSafeModeConsentDialog";
import { sessionUnrestricted } from "../../lib/agent-session-modes";
import { hermesTuiDebugAvailable } from "../../lib/hermes-tui-debug";
import { AgentSessionBar } from "./chat-turns/AgentSessionBar";
import { galleryNoop } from "./chat-turns/TranscriptViews";
import { copyableTextForTurn } from "./chat-turns/AgentChatTurnRow";
import { AgentErrorBanner, SessionCompactDialog } from "./chat-turns/SessionNotices";
import { AgentArtifactPanel } from "./chat-turns/AgentArtifactPanel";
import type { RenderAgentWorkspaceLayoutDependencies } from "./AgentWorkspaceLayout-types";

export function renderAgentWorkspaceLayout(dependencies: RenderAgentWorkspaceLayoutDependencies) {
  const {
    ACTIVITY_DRAWER_ENABLED,
    activeAgentCount,
    activePanel,
    activityDrawerOpen,
    activityRecords,
    activityStatus,
    agentScrollRef,
    artifactPanel,
    bridgeStarting,
    canShareAgentSession,
    compactSessionId,
    composer,
    composerClearance,
    composerHasContent,
    compressSessionContext,
    deleteSelectedHermesSession,
    detailContent,
    downloadArtifact,
    fetchSessionUsage,
    galleryErrors,
    generationModel,
    generationPrivacyBadge,
    hermesTurns,
    heroChipPhase,
    heroChipsHoverRef,
    heroGreeting,
    heroLeaving,
    heroMode,
    heroShortcuts,
    imageSafeModeConsentRequest,
    modelForActivitySession,
    newSessionMode,
    onMoveSessionToProject,
    openArtifact,
    openSessionFromDrawer,
    openTimelineArtifact,
    origin,
    projectContext,
    renameHermesSession,
    resolveImageSafeModeConsent,
    resolveModel,
    retryGatewayConnection,
    runShortcut,
    selectedHermesSession,
    selectedHermesSessionId,
    selectedHermesSessionIsProvisional,
    selectedHistoryLoaded,
    selectedTask,
    sendErrorIssueReport,
    sessionInProject,
    sessionShareUrl,
    setActivityDrawerOpen,
    setArtifactPanel,
    setCompactSessionId,
    setError,
    setSessionShareUrl,
    setShareSessionId,
    setUsagePanelSessionId,
    shareSessionId,
    startupSessionHydrationPending,
    steerSessionFromDrawer,
    stopHermesSession,
    stopHermesSubagent,
    submitting,
    submittingErrorIssueReport,
    surfacedArtifacts,
    timelineArtifacts,
    titleForPendingSession,
    usageDemo,
    usagePanelSessionId,
    visibleError,
    visibleErrorRetryable,
    visibleErrorState,
    workingSessionIds,
  } = dependencies;

  return (
    <section
      className="agent-workspace"
      aria-label="Session"
      data-artifact-panel={artifactPanel ? "open" : undefined}
      data-hero={heroMode ? "true" : undefined}
    >
      {/* Feature 11: the Agent activity drawer and its toggle. One top-level
            surface so it shows every session's live activity, not
            just the selected one. The toggle is hidden while the drawer is open
            (the drawer carries its own close control) and surfaces the count of
            sessions currently doing work.
            Gated by ACTIVITY_DRAWER_ENABLED (currently false): with no toggle the
            drawer is unreachable, since nothing else flips activityDrawerOpen to
            true. See the flag's note for the open-wrong-session bug it parks. */}
      {ACTIVITY_DRAWER_ENABLED && !activityDrawerOpen ? (
        <button
          type="button"
          className="agent-activity-toggle"
          onClick={() => setActivityDrawerOpen(true)}
          aria-label="Show agent activity"
        >
          <IconBolt size={15} ariaHidden />
          <span className="agent-activity-toggle-label">Activity</span>
          {activeAgentCount > 0 ? (
            <span className="agent-activity-toggle-count" aria-hidden>
              {activeAgentCount}
            </span>
          ) : null}
        </button>
      ) : null}
      <AgentActivityDrawer
        open={activityDrawerOpen}
        records={activityRecords}
        status={activityStatus}
        now={Date.now()}
        titleForSession={titleForPendingSession}
        modelForSession={modelForActivitySession}
        onOpenSession={openSessionFromDrawer}
        onSteerSession={steerSessionFromDrawer}
        canSteerSession={(sessionId) => workingSessionIds.has(sessionId)}
        onStopSession={(sessionId) => void stopHermesSession(sessionId)}
        onStopSubagent={stopHermesSubagent}
        onClose={() => setActivityDrawerOpen(false)}
        footer={
          <AgentArtifactsSection
            artifacts={timelineArtifacts}
            onOpenArtifact={openTimelineArtifact}
          />
        }
      />
      {!heroMode && !(!newSessionMode && !selectedHermesSessionId && selectedTask) ? (
        <AgentSessionBar
          origin={origin}
          artifactCount={!newSessionMode ? surfacedArtifacts.length : 0}
          artifactsOpen={artifactPanel !== null}
          onToggleArtifacts={() => setArtifactPanel((open) => (open ? null : { view: "list" }))}
          privacyBadge={generationPrivacyBadge}
          // The badge describes the selected session, not the live runtime:
          // every send re-enforces the session's recorded mode, so a
          // sandboxed session stays sandboxed even while an Unrestricted
          // runtime from another session is still up. The hero composer's
          // picker covers the new-session draft.
          fullMode={
            !newSessionMode &&
            !selectedHermesSessionIsProvisional &&
            sessionUnrestricted(selectedHermesSessionId)
          }
          title={
            !newSessionMode && selectedHermesSessionId
              ? (selectedHermesSession?.title ?? "")
              : undefined
          }
          shareUrl={
            !newSessionMode && selectedHermesSessionId && !selectedHermesSessionIsProvisional
              ? (sessionShareUrl ?? undefined)
              : undefined
          }
          onRename={
            !newSessionMode && selectedHermesSessionId && !selectedHermesSessionIsProvisional
              ? (title) => renameHermesSession(selectedHermesSessionId, title)
              : undefined
          }
          onShare={
            // Gate on loaded history: sharing snapshots the transcript, and
            // hermesTurns is empty until the selected session hydrates. Sharing
            // early or while a response is streaming would persist an
            // empty/partial session permanently.
            canShareAgentSession({
              selectedSessionId: selectedHermesSessionId,
              newSessionMode,
              provisional: selectedHermesSessionIsProvisional,
              historyLoaded: selectedHistoryLoaded,
              working: selectedHermesSessionId
                ? workingSessionIds.has(selectedHermesSessionId)
                : false,
            }) && selectedHermesSessionId
              ? () => setShareSessionId(selectedHermesSessionId)
              : undefined
          }
          inProject={sessionInProject}
          projectContext={sessionInProject ? projectContext : undefined}
          onMoveToProject={
            onMoveSessionToProject &&
            !newSessionMode &&
            selectedHermesSessionId &&
            !selectedHermesSessionIsProvisional
              ? () => onMoveSessionToProject(selectedHermesSessionId)
              : undefined
          }
          onDelete={
            !newSessionMode && selectedHermesSessionId && !selectedHermesSessionIsProvisional
              ? () => void deleteSelectedHermesSession(selectedHermesSessionId)
              : undefined
          }
          onShowUsage={
            !newSessionMode && selectedHermesSessionId && !selectedHermesSessionIsProvisional
              ? () => setUsagePanelSessionId(selectedHermesSessionId)
              : undefined
          }
          onCompactContext={
            !newSessionMode && selectedHermesSessionId && !selectedHermesSessionIsProvisional
              ? () => setCompactSessionId(selectedHermesSessionId)
              : undefined
          }
          // Dev builds only: open the raw Hermes TUI on this exact session,
          // under the same sandbox/unrestricted mode June used for it. Lets a
          // developer tell a June adapter/UI bug apart from a Hermes one.
          onOpenTuiDebug={
            hermesTuiDebugAvailable() &&
            !newSessionMode &&
            selectedHermesSessionId &&
            !selectedHermesSessionIsProvisional
              ? () => {
                  setError(null);
                  void openHermesTuiDebug({
                    sessionId: selectedHermesSessionId,
                    unrestricted: sessionUnrestricted(selectedHermesSessionId),
                  }).catch((err: unknown) => setError(messageFromError(err)));
                }
              : undefined
          }
        />
      ) : null}
      {heroMode ? (
        <section
          className="agent-main"
          aria-label="Agent task details"
          data-hero="true"
          data-hero-leaving={heroLeaving ? "true" : undefined}
        >
          {visibleError ? (
            <AgentErrorBanner
              message={visibleError}
              onRetry={visibleErrorRetryable ? () => void retryGatewayConnection() : undefined}
              onReportBug={
                visibleErrorState?.issueReport
                  ? () => void sendErrorIssueReport(visibleErrorState)
                  : undefined
              }
              reportBugSubmitting={submittingErrorIssueReport}
              onDismiss={() => setError(null)}
            />
          ) : null}
          <div className="agent-hero-heading">
            <h2 className="agent-hero-title">{heroGreeting}</h2>
          </div>
          {composer}
          {activePanel === "chat" ? (
            <div className="agent-hero-suggestions">
              {/* The chips bow out while the composer holds a draft: staging a
                    chip runs setContent, which replaces the whole composer
                    document, so a click here would clobber what the person
                    typed. Once they're typing, the suggestions have done their
                    job. They return when the field is cleared. */}
              <div
                className="agent-hero-chips"
                data-phase={heroChipPhase}
                data-hidden={composerHasContent ? "true" : undefined}
                onMouseEnter={() => {
                  heroChipsHoverRef.current = true;
                }}
                onMouseLeave={() => {
                  heroChipsHoverRef.current = false;
                }}
              >
                {heroShortcuts.map((shortcut, index) => (
                  <button
                    key={shortcut.key}
                    type="button"
                    className="agent-hero-chip"
                    style={{ "--chip-i": index } as CSSProperties}
                    title={shortcut.description}
                    disabled={submitting}
                    onClick={() => runShortcut(shortcut)}
                  >
                    <span className="agent-hero-chip-icon" aria-hidden>
                      {shortcut.icon}
                    </span>
                    {shortcut.title}
                  </button>
                ))}
              </div>
              <p className="agent-hero-footnote">
                {bridgeStarting || startupSessionHydrationPending
                  ? "Getting June ready…"
                  : heroPrivacyFootnote(generationModel, generationPrivacyBadge)}
              </p>
            </div>
          ) : null}
        </section>
      ) : (
        <>
          <div
            ref={agentScrollRef}
            className="agent-scroll"
            style={
              {
                "--agent-composer-clearance": `${composerClearance}px`,
              } as CSSProperties
            }
          >
            <section className="agent-main" aria-label="Agent task details">
              {galleryErrors ? (
                <AgentErrorBanner
                  message="Could not connect to Hermes gateway."
                  onRetry={galleryNoop}
                  onDismiss={galleryNoop}
                />
              ) : visibleError ? (
                <AgentErrorBanner
                  message={visibleError}
                  onRetry={visibleErrorRetryable ? () => void retryGatewayConnection() : undefined}
                  onReportBug={
                    visibleErrorState?.issueReport
                      ? () => void sendErrorIssueReport(visibleErrorState)
                      : undefined
                  }
                  reportBugSubmitting={submittingErrorIssueReport}
                  onDismiss={() => setError(null)}
                />
              ) : null}
              {detailContent}
              {composer}
            </section>
          </div>
          {/* Portaled out of .main-panel: WKWebView clips a composited fixed
                element to an overflow-hidden ancestor, and the panel sits
                entirely outside the card's box — so whenever the engine
                transiently promoted its layer (animation replays, drag-time
                renderer churn), the panel blinked out. As a direct child of
                .app-shell nothing excludes its box, and the shell still carries
                the CSS variables and data-attributes its rules read. */}
          {artifactPanel
            ? createPortal(
                <AgentArtifactPanel
                  artifacts={surfacedArtifacts}
                  state={artifactPanel}
                  onShowList={() => setArtifactPanel({ view: "list" })}
                  onOpen={openArtifact}
                  onDownload={downloadArtifact}
                  onClose={() => setArtifactPanel(null)}
                />,
                document.querySelector(".app-shell") ?? document.body,
              )
            : null}
          {usageDemo || usagePanelSessionId
            ? createPortal(
                <div
                  className="agent-usage-overlay"
                  role="presentation"
                  onClick={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (usageDemo) {
                      // Closing while demoing clears the demo state, matching
                      // __usageDemo("off"). Guard: the command is dev-only.
                      (window as unknown as { __usageDemo?: (v: "off") => void }).__usageDemo?.(
                        "off",
                      );
                    }
                    setUsagePanelSessionId(null);
                  }}
                >
                  <SessionUsagePanel
                    // A stable id so the panel refetches when the fixture swaps.
                    sessionId={usageDemo ? usageDemo.usage.sessionId : (usagePanelSessionId ?? "")}
                    fetchUsage={
                      usageDemo
                        ? // Small artificial delay so the skeleton and the eased
                          // dot-fill entrance are both visible on each swap.
                          () =>
                            new Promise((resolve) =>
                              setTimeout(() => resolve(usageDemo.usage), 250),
                            )
                        : fetchSessionUsage
                    }
                    onClose={() => {
                      if (usageDemo) {
                        (window as unknown as { __usageDemo?: (v: "off") => void }).__usageDemo?.(
                          "off",
                        );
                      }
                      setUsagePanelSessionId(null);
                    }}
                    resolveModel={
                      usageDemo
                        ? (id) => (id === usageDemo.model.id ? usageDemo.model : undefined)
                        : resolveModel
                    }
                  />
                </div>,
                document.querySelector(".app-shell") ?? document.body,
              )
            : null}
          {/* Dialog portals to document.body itself, so it is mounted directly
                rather than wrapped in an overlay like the usage panel. */}
          {compactSessionId ? (
            <SessionCompactDialog
              open
              sessionId={compactSessionId}
              compress={compressSessionContext}
              onClose={() => setCompactSessionId(null)}
            />
          ) : null}
          {!newSessionMode && selectedHermesSessionId && !selectedHermesSessionIsProvisional ? (
            <ShareDialog
              key={selectedHermesSessionId}
              open={shareSessionId === selectedHermesSessionId}
              onClose={() => setShareSessionId(null)}
              onLinkChange={setSessionShareUrl}
              item={{
                kind: "session",
                itemId: selectedHermesSessionId,
                title: selectedHermesSession?.title ?? "",
                // Sessions share the visible user/assistant transcript only:
                // tool events, reasoning, and hidden context never enter the
                // payload. Snapshot at share time.
                buildPayload: () =>
                  buildSessionPayload({
                    title: selectedHermesSession?.title ?? "",
                    messages: hermesTurns
                      .filter((turn) => turn.role === "user" || turn.role === "assistant")
                      .map((turn) => ({
                        role: turn.role as "user" | "assistant",
                        content: copyableTextForTurn(turn),
                      }))
                      .filter((message) => message.content.length > 0),
                  }),
              }}
            />
          ) : null}
        </>
      )}
      {imageSafeModeConsentRequest ? (
        imageSafeModeConsentRequest.variant === "video-slash" ? (
          <VideoSafeModeConsentDialog
            onSkipVideo={(dontAskAgain) =>
              resolveImageSafeModeConsent({ action: "keep", dontAskAgain })
            }
            onTurnOffSafeMode={(dontAskAgain) =>
              resolveImageSafeModeConsent({ action: "turnOff", dontAskAgain })
            }
            onDismiss={() => resolveImageSafeModeConsent({ action: "dismiss" })}
          />
        ) : (
          <ImageSafeModeConsentDialog
            variant={imageSafeModeConsentRequest.variant}
            onKeepSafeMode={(dontAskAgain) =>
              resolveImageSafeModeConsent({ action: "keep", dontAskAgain })
            }
            onTurnOffSafeMode={(dontAskAgain) =>
              resolveImageSafeModeConsent({ action: "turnOff", dontAskAgain })
            }
            onDismiss={() => resolveImageSafeModeConsent({ action: "dismiss" })}
          />
        )
      ) : null}
    </section>
  );
}
