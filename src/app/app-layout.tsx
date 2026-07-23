import { AnimatePresence, motion } from "framer-motion";
import type { CSSProperties } from "react";
import { FundingChip, FundingNotice } from "../components/account/FundingNotice";
import { MoveNoteToFolderDialog } from "../components/folders/MoveNoteToFolderDialog";
import { MoveSessionToProjectDialog } from "../components/folders/MoveSessionToProjectDialog";
import { NoteChatPanel } from "../components/note-chat/NoteChatPanel";
import { ShareDialog } from "../components/share/ShareDialog";
import { buildNotePayload } from "../lib/share-payload";
import { GlobalRecorderPill } from "../components/recorder/GlobalRecorderPill";
import { PermissionBanner } from "../components/permissions/PermissionBanner";
import { Sidebar } from "../components/sidebar/Sidebar";
import { TabBar } from "../components/tabs/TabBar";
import { ConnectorApprovalsTray } from "../components/connectors/ConnectorApprovalsTray";
import { ComputerUseApprovalsTray } from "../components/agent/ComputerUseApprovalsTray";
import { OPEN_REFERRAL_DIALOG_EVENT, ReferralNudge } from "../components/referral/ReferralNudge";
import { markReferralNudgeClickedThrough } from "../lib/referral-nudge";
import { Dialog } from "../components/ui/Dialog";
import { osAccountsOpenPortal } from "../lib/tauri";
import { isWindowsPlatform } from "../lib/platform";
import { messageFromError } from "../lib/errors";
import type { HermesSessionInfo } from "../lib/tauri";
import type { NoteListItemDto } from "../lib/tauri";
import {
  MAX_UPGRADE_BUSY_LABEL,
  MAX_UPGRADE_CHARGE_CONFIRM_BODY,
  MAX_UPGRADE_CONFIRM_BODY,
  MAX_UPGRADE_CONFIRM_LABEL,
  MAX_UPGRADE_CONFIRM_TITLE,
  MAX_UPGRADE_PORTAL_LABEL,
} from "../lib/max-upgrade";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { handleSidebarResizeStart } from "./sidebar-resize";
import { UpdateHub } from "./app-effects/update-ui";
import { SidebarToggleGlyph, handleTitlebarPointerDown } from "./app-helpers";
import {
  COMPOSER_FUNDING_DISABLED_REASON,
  SIDEBAR_COLLAPSE_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarMaxWidth,
} from "./app-shell";
import type { RenderAppLayoutDependencies } from "./app-layout-types";

export function renderAppLayout(dependencies: RenderAppLayoutDependencies) {
  const {
    accessibilityBannerDismissed,
    accessibilityBlocked,
    account,
    activateTab,
    activeTabId,
    activeView,
    agentSessions,
    agentSessionsListRef,
    appMaxGrantWaitRef,
    billingNotice,
    captureActive,
    changeSettingsTab,
    checkingUpdate,
    closeOtherTabs,
    closeTab,
    completedSessions,
    confirmDeleteNote,
    confirmMaxUpgrade,
    detailScrollerActive,
    dispatch,
    error,
    fundingAccount,
    fundingRequired,
    handleCreateFolder,
    handleDeleteNote,
    handleEnableAccessibility,
    handleKeepRecordingAfterInactivityPrompt,
    handleOpenNoteChatInAgent,
    handleOpenRecordingNote,
    handlePauseRecordingAfterInactivityPrompt,
    handleRelaunchUpdate,
    handleRemoveNoteFromFolder,
    handleRemoveSessionFromFolder,
    handleRenameAgentSession,
    handleReorderTabs,
    handleReportIssue,
    handleSelectNote,
    handleSetNoteFolder,
    handleSetSessionFolder,
    handleSignOut,
    handleToggleSessionCompleted,
    mainPanelBodyRef,
    maxUpgradeError,
    maxUpgradePrompt,
    moveDialogNoteIds,
    moveDialogSessionIds,
    noteChat,
    noteChatOpen,
    noteDetailScrollerActive,
    notesListRef,
    openNewChatTab,
    openSettings,
    openTab,
    pendingSessionProjectRef,
    pillIsDemo,
    pillStatus,
    preparingUpdate,
    readyUpdate,
    recordingInactivityPrompt,
    recordingInactivitySecondsRemaining,
    recordingNoteTitle,
    recoverableNoteIds,
    referralNudgeMoment,
    referralNudgeSourceRef,
    refreshFundingAccount,
    relaunchingUpdate,
    selectedNote,
    sessionFolders,
    setAccessibilityBannerDismissed,
    setActiveAgentSession,
    setActiveView,
    setAgentOrigin,
    setConfirmDeleteNote,
    setError,
    setFolderReturnTarget,
    setMaxUpgradePrompt,
    setMoveDialogNoteIds,
    setMoveDialogSessionIds,
    setNoteChatOpen,
    setNoteShareUrl,
    setOriginAllNotes,
    setOriginFolderId,
    setReferralNudgeMoment,
    setShareNoteOpen,
    setSidebarCollapsed,
    setSidebarResizing,
    setSidebarTransition,
    setSidebarWidth,
    setUpdateProgress,
    setUpdateStatus,
    settingsDetailScrollerActive,
    settingsReturnView,
    settingsTab,
    shareNoteOpen,
    sidebarCollapsed,
    sidebarRecorderStatus,
    sidebarResizing,
    sidebarTransition,
    sidebarWidth,
    state,
    tabItems,
    takeNewTabIntent,
    updateProgress,
    updateProgressHiddenRef,
    updateStatus,
    updateStatusDisplay,
    updateStatusLeaving,
    workspaceContent,
  } = dependencies;

  return (
    <main
      className="app-shell"
      data-platform={isWindowsPlatform() ? "windows" : undefined}
      data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"}
      data-sidebar-resizing={sidebarResizing ? "true" : "false"}
      data-sidebar-transition={sidebarTransition}
      style={
        {
          // The grid columns read this directly, so collapsed must pin it to 0
          // (the stored width is preserved for the next expand). During a drag
          // the resize logic overrides it imperatively.
          "--sidebar-w-current": `${sidebarCollapsed ? 0 : sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <div
        className="titlebar-drag"
        aria-hidden
        data-tauri-drag-region
        onPointerDown={handleTitlebarPointerDown}
      />
      <button
        type="button"
        className="chrome-sidebar-toggle"
        aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        aria-pressed={sidebarCollapsed}
        onClick={() => {
          setSidebarTransition("none");
          if (sidebarCollapsed) {
            setSidebarWidth((width) => Math.max(width, SIDEBAR_DEFAULT_WIDTH));
            setSidebarCollapsed(false);
            return;
          }
          setSidebarCollapsed(true);
        }}
      >
        <SidebarToggleGlyph />
      </button>
      <Sidebar
        notes={state.notes}
        activeView={activeView}
        account={account}
        settingsTab={settingsTab}
        onSettingsTabChange={changeSettingsTab}
        onChangeView={(view) => {
          if (takeNewTabIntent()) {
            openTab({ view });
            return;
          }
          if (view === "settings") openSettings();
          else setActiveView(view);
          setAgentOrigin(undefined);
          if (view !== "agent") {
            setActiveAgentSession(undefined);
            pendingSessionProjectRef.current = null;
          }
          if (view === "folders") {
            setFolderReturnTarget(undefined);
            dispatch({ type: "folderSelected", folderId: undefined });
          }
          if (view !== "meetings" && view !== "notes") {
            setOriginFolderId(undefined);
            setOriginAllNotes(false);
            setFolderReturnTarget(undefined);
          }
        }}
        onExitSettings={() => setActiveView(settingsReturnView)}
        onSignOut={() => void handleSignOut()}
        onReportIssue={handleReportIssue}
        onSelectNote={(noteId) => {
          if (takeNewTabIntent()) {
            openTab({ view: "meetings", noteId });
            return;
          }
          void handleSelectNote(noteId);
        }}
        onDeleteNote={(noteId) => void handleDeleteNote(noteId)}
        onOpenMoveDialog={(noteId) => setMoveDialogNoteIds([noteId])}
        onRemoveNoteFromFolder={(noteId, folderId) =>
          void handleRemoveNoteFromFolder(noteId, folderId)
        }
        onNewAgentSession={() => {
          pendingSessionProjectRef.current = null;
          setAgentOrigin(undefined);
          setActiveAgentSession(undefined);
          setActiveView("agent");
        }}
        onRenameAgentSession={handleRenameAgentSession}
        onSelectAgentSession={(session) => {
          if (takeNewTabIntent()) {
            openTab({ view: "agent", agentSessionId: session.id });
            return;
          }
          setAgentOrigin(undefined);
          setActiveAgentSession(session);
          setActiveView("agent");
        }}
        sessionFolderIds={sessionFolders}
        completedSessionIds={completedSessions}
        onToggleSessionCompleted={handleToggleSessionCompleted}
        onOpenSessionMoveDialog={(sessionId) => setMoveDialogSessionIds([sessionId])}
        onRemoveSessionFromFolder={(sessionId, folderId) =>
          void handleRemoveSessionFromFolder(sessionId, folderId)
        }
        recoverableNoteIds={recoverableNoteIds}
        recordingStatus={sidebarRecorderStatus}
        recordingTitle={recordingNoteTitle}
        onOpenRecording={() => (pillIsDemo ? undefined : void handleOpenRecordingNote())}
        collapsed={sidebarCollapsed}
        footerAccessory={
          <>
            <UpdateHub
              readyUpdate={readyUpdate}
              status={updateStatus}
              failed={updateStatusDisplay.failed}
              statusLeaving={updateStatusLeaving}
              checking={checkingUpdate}
              preparing={preparingUpdate}
              relaunching={relaunchingUpdate}
              progress={updateProgress}
              onDismissStatus={() => {
                if (preparingUpdate) updateProgressHiddenRef.current = true;
                setUpdateStatus(null);
                if (!preparingUpdate) setUpdateProgress(null);
              }}
              onRelaunch={handleRelaunchUpdate}
            />
            {fundingRequired ? (
              <FundingChip account={fundingAccount} onRefresh={refreshFundingAccount} />
            ) : null}
          </>
        }
      />
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={(event) =>
          handleSidebarResizeStart(event, sidebarWidth, {
            collapseWidth: SIDEBAR_COLLAPSE_WIDTH,
            minWidth: SIDEBAR_MIN_WIDTH,
            maxWidth: sidebarMaxWidth,
            onStart: () => {
              setSidebarResizing(true);
              setSidebarTransition("none");
            },
            onEnd: (finalWidth) => {
              if (finalWidth <= SIDEBAR_COLLAPSE_WIDTH) {
                setSidebarResizing(false);
                setSidebarTransition("smooth");
                setSidebarWidth(Math.max(0, finalWidth));
                setSidebarCollapsed(true);
                return;
              }
              const nextWidth = Math.min(
                sidebarMaxWidth(),
                Math.max(SIDEBAR_MIN_WIDTH, finalWidth),
              );
              setSidebarResizing(false);
              setSidebarCollapsed(false);
              setSidebarWidth(nextWidth);
            },
          })
        }
      />
      <div className="main-column">
        <TabBar
          tabs={tabItems}
          activeTabId={activeTabId}
          onActivate={activateTab}
          onClose={closeTab}
          onCloseOthers={closeOtherTabs}
          onNew={openNewChatTab}
          onReorder={handleReorderTabs}
          layoutFrozen={sidebarResizing}
          onDragRegionPointerDown={handleTitlebarPointerDown}
        />
        <section className="main-panel">
          {accessibilityBlocked && !accessibilityBannerDismissed ? (
            <PermissionBanner
              onDismiss={() => setAccessibilityBannerDismissed(true)}
              onEnableAccessibility={handleEnableAccessibility}
            />
          ) : null}
          <div
            ref={mainPanelBodyRef}
            className="main-panel-body"
            data-active-view={activeView}
            data-detail-scroller={detailScrollerActive ? "true" : undefined}
            data-note-detail-scroller={
              noteDetailScrollerActive || settingsDetailScrollerActive ? "true" : undefined
            }
          >
            {error ? <p className="error-banner">{error}</p> : null}
            {billingNotice ? (
              <p className="notice-banner" role="status">
                {billingNotice}{" "}
                {appMaxGrantWaitRef.current?.phase === "slow" ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      void osAccountsOpenPortal().catch((err) => setError(messageFromError(err)));
                    }}
                  >
                    {MAX_UPGRADE_PORTAL_LABEL}
                  </button>
                ) : null}
              </p>
            ) : null}
            <div className="workspace">{workspaceContent}</div>
          </div>
          <AnimatePresence>
            {pillStatus ? (
              <motion.div
                key="global-recorder"
                className="global-recorder-dock"
                initial={{ opacity: 0, y: -8 }}
                animate={{
                  opacity: 1,
                  y: 0,
                  transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] },
                }}
                exit={{
                  opacity: 0,
                  y: -8,
                  transition: { duration: 0.14, ease: [0.22, 1, 0.36, 1] },
                }}
              >
                <GlobalRecorderPill
                  status={pillStatus}
                  title={recordingNoteTitle}
                  onOpen={() => (pillIsDemo ? undefined : void handleOpenRecordingNote())}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </section>
        {activeView === "meetings" && selectedNote && noteChatOpen ? (
          <NoteChatPanel
            note={{ id: selectedNote.id, title: selectedNote.title }}
            chat={noteChat}
            recordingActive={captureActive}
            creditActionsDisabledReason={
              fundingRequired ? COMPOSER_FUNDING_DISABLED_REASON : undefined
            }
            renderFundingNotice={
              fundingRequired
                ? (textFundingContext) => (
                    <FundingNotice
                      account={fundingAccount}
                      onRefresh={refreshFundingAccount}
                      textFundingContext={textFundingContext}
                    />
                  )
                : undefined
            }
            onClose={() => setNoteChatOpen(false)}
            onOpenInAgent={(sessionId) => {
              setNoteChatOpen(false);
              handleOpenNoteChatInAgent(
                { id: selectedNote.id, title: selectedNote.title },
                sessionId,
              );
            }}
          />
        ) : null}
        <ConfirmDialog
          open={confirmDeleteNote && !!selectedNote}
          onClose={() => setConfirmDeleteNote(false)}
          onConfirm={async () => {
            setConfirmDeleteNote(false);
            if (selectedNote) await handleDeleteNote(selectedNote.id);
          }}
          title="Delete note?"
          description="This permanently deletes the note and its transcript. This can't be undone."
          confirmLabel="Delete note"
          destructive
        />
        {selectedNote ? (
          <ShareDialog
            key={selectedNote.id}
            open={shareNoteOpen}
            onClose={() => setShareNoteOpen(false)}
            onLinkChange={setNoteShareUrl}
            item={{
              kind: "note",
              itemId: selectedNote.id,
              title: selectedNote.title,
              // Notes share the rendered markdown: edited content when
              // present, generated otherwise. Snapshot at share time.
              buildPayload: () =>
                buildNotePayload({
                  title: selectedNote.title,
                  markdown: selectedNote.editedContent ?? selectedNote.generatedContent ?? "",
                }),
            }}
          />
        ) : null}
      </div>
      <Dialog
        open={recordingInactivityPrompt !== null}
        onClose={handleKeepRecordingAfterInactivityPrompt}
        title="Still in a meeting?"
        description="June has not heard meeting audio for a while."
        width={420}
        footer={
          <>
            <button
              type="button"
              className="primary-action"
              onClick={handlePauseRecordingAfterInactivityPrompt}
            >
              Pause recording
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              onClick={handleKeepRecordingAfterInactivityPrompt}
            >
              Keep recording
            </button>
          </>
        }
      >
        <div className="dialog-body">
          <p className="recording-inactivity-copy">
            June will pause this recording in {recordingInactivitySecondsRemaining} seconds if you
            do not answer.
          </p>
        </div>
      </Dialog>
      <MoveNoteToFolderDialog
        open={moveDialogNoteIds !== null}
        onClose={() => setMoveDialogNoteIds(null)}
        notes={
          moveDialogNoteIds
            ? moveDialogNoteIds
                .map((id) => state.notes.find((n) => n.id === id))
                .filter((note): note is NoteListItemDto => note !== undefined)
            : []
        }
        folders={state.folders}
        onSetFolder={(noteId, folderId) => handleSetNoteFolder(noteId, folderId, { rethrow: true })}
        onCreateFolder={(name) => handleCreateFolder(name)}
        onRemoveFolder={(noteId, folderId) =>
          handleRemoveNoteFromFolder(noteId, folderId, { rethrow: true })
        }
        onMoved={() => notesListRef.current?.resetSelection()}
      />
      <MoveSessionToProjectDialog
        open={moveDialogSessionIds !== null}
        onClose={() => setMoveDialogSessionIds(null)}
        sessions={
          moveDialogSessionIds
            ? moveDialogSessionIds
                .map((id) => agentSessions.find((s) => s.id === id))
                .filter((session): session is HermesSessionInfo => session !== undefined)
            : []
        }
        sessionFolderIds={sessionFolders}
        folders={state.folders}
        onSetFolder={(sessionId, folderId) =>
          handleSetSessionFolder(sessionId, folderId, { rethrow: true })
        }
        onCreateFolder={(name) => handleCreateFolder(name)}
        onRemoveFolder={(sessionId, folderId) =>
          handleRemoveSessionFromFolder(sessionId, folderId, { rethrow: true })
        }
        onMoved={() => agentSessionsListRef.current?.resetSelection()}
      />
      <ConfirmDialog
        open={maxUpgradePrompt !== null}
        onClose={() => setMaxUpgradePrompt(null)}
        onConfirm={confirmMaxUpgrade}
        title={MAX_UPGRADE_CONFIRM_TITLE}
        description={
          maxUpgradeError ??
          (maxUpgradePrompt?.transport === "charge_now"
            ? MAX_UPGRADE_CHARGE_CONFIRM_BODY
            : MAX_UPGRADE_CONFIRM_BODY)
        }
        confirmLabel={MAX_UPGRADE_CONFIRM_LABEL}
        confirmBusyLabel={MAX_UPGRADE_BUSY_LABEL}
      />
      {/* Connector action approvals (approval trust mode) can arrive from a
            routine or chat in any view, so the tray is mounted at the shell. */}
      <div className="shell-approvals-stack">
        <ComputerUseApprovalsTray />
        <ConnectorApprovalsTray />
      </div>
      {/* The referral delight nudge floats bottom-left at the shell so it can
            appear over any view; click-through opens the sidebar-owned referral
            dialog by event. */}
      {referralNudgeMoment ? (
        <ReferralNudge
          moment={referralNudgeMoment}
          onInvite={() => {
            // Ends all future nudging, per the frequency rules — but only for
            // real trigger shows; demo cards must not poison the caps.
            if (referralNudgeSourceRef.current === "trigger") markReferralNudgeClickedThrough();
            setReferralNudgeMoment(null);
            window.dispatchEvent(new Event(OPEN_REFERRAL_DIALOG_EVENT));
          }}
          onDismiss={() => setReferralNudgeMoment(null)}
        />
      ) : null}
    </main>
  );
}
