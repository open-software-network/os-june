import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconExclamationTriangle } from "central-icons/IconExclamationTriangle";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { AnimatePresence, motion } from "framer-motion";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconFileText } from "central-icons/IconFileText";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconShieldCrossed } from "central-icons/IconShieldCrossed";
import { IconStop } from "central-icons/IconStop";
import { DotSpinner } from "../../DotSpinner";
import { Dialog } from "../../ui/Dialog";
import { Spinner } from "../../ui/Spinner";
import { ComposerModelPicker } from "./ModelPicker";
import { autoPillDesignation } from "../../../lib/suggested-models";
import { AUTO_MODEL_ID, modelOptions } from "../../settings/ModelPickerDialog";
import { ModelPickerPopover } from "../../settings/ModelPickerPopover";
import { isBuiltinComposerSlashCommand } from "../../../lib/agent-composer-slash-commands";
import { ComposerEditor } from "./ComposerEditor";
import { CategoryIcon } from "./CategoryIcon";
import { REPORT_CATEGORIES } from "./reportCategory";
import { ReportDialog } from "../ReportDialog";
import {
  SANDBOX_OPTIONS,
  rememberUnrestrictedAcknowledged,
  unrestrictedAcknowledged,
} from "../agent-workspace-config";
import { rememberComposerDraft } from "../agent-session-continuity";
import { AgentScrollToLatestButton } from "../chat-turns/TranscriptViews";
import { formatComposerTokenCount } from "./composer-input-helpers";
import { AgentAttachmentTile } from "../agent-workspace-support";
import type { RenderAgentComposerDependencies } from "./AgentComposer-types";

export function renderAgentComposer(dependencies: RenderAgentComposerDependencies) {
  const {
    SESSION_BUSY_NOTICE,
    activeGenerationCostQuality,
    activePanel,
    agentScrollRef,
    attachMenuOpen,
    attachMenuRef,
    attachTriggerRef,
    attachments,
    attachmentsRef,
    categoryRef,
    composerBoxRef,
    composerDraftKeyRef,
    composerEditorRef,
    onComposerFocusChange,
    composerInSteerState,
    composerModelFlyout,
    composerModelOpen,
    composerModelPopoverRef,
    composerModelRootSearchRef,
    composerModelSearchRef,
    composerModelTriggerRef,
    composerRef,
    composerThinkingLevel,
    composerTiptapEditorRef,
    confirmUnrestricted,
    creditActionsDisabledReason,
    draft,
    draftRef,
    dropActive,
    editOversizeComposerInput,
    fullModeDraft,
    fullModeDraftRef,
    galleryErrors,
    generatingImage,
    generatingVideo,
    generationModel,
    generationModelOptions,
    handleComposerDragOver,
    handleComposerDrop,
    handleComposerPaste,
    handleCostQualityChange,
    handleReportDialogSent,
    handleSelectGenerationModel,
    handleSelectThinkingLevel,
    heroMode,
    imageModelWarningText,
    imageSlashBlockedByModel,
    importReportDialogDroppedFiles,
    importingFiles,
    loadSkillCommands,
    modelRootSearch,
    modelSearch,
    openComposerModelPicker,
    openReportDialog,
    pickAttachments,
    pickReportDialogAttachments,
    preferredVisionModel,
    proceedWithOversizeComposerInput,
    removeAttachment,
    removeReportDialogAttachment,
    renderFundingNotice,
    renderQueuedAttachmentFollowUp,
    renderSteerCard,
    reportDialogAttachments,
    reportDialogCategory,
    reportDialogDescription,
    reportDialogOpen,
    restoreComposerDraft,
    sandboxFirstItemRef,
    sandboxMenuOpen,
    sandboxMenuRef,
    sandboxTriggerRef,
    scrollTranscriptToLatest,
    seedComposerNoteRef,
    selectedFollowUpCount,
    selectedHermesSessionId,
    selectedHermesSessionIsProvisional,
    selectedQueuedAttachmentFollowUps,
    selectedSteerCards,
    selectedTask,
    selectedUpNextDemoFollowUps,
    sendReviewableIssueReport,
    setAttachMenuOpen,
    setCategory,
    setComposerModelFlyout,
    setComposerModelOpen,
    setConfirmUnrestricted,
    setDraft,
    setDropActive,
    setFullModeDraft,
    setModelRootSearch,
    setModelSearch,
    setReportDialogCategory,
    setReportDialogDescription,
    setReportDialogOpen,
    setSandboxMenuOpen,
    setSteerQueueOpen,
    showImageModelWarning,
    skillCommandLoading,
    skills,
    startDictation,
    steerCardsFade,
    steerCardsListRef,
    steerQueueOpen,
    stopHermesSession,
    stoppingSessionIds,
    submit,
    submitting,
    switchOversizeComposerModel,
    textActionsDisabledReason,
    textFundingContext,
    veniceApiKeyConfigured,
    visibleComposerSizeWarning,
    visibleFollowUpQueueKey,
    visibleIssueReportHasUnsentContext,
    visibleIssueReportImportingFiles,
    visibleIssueReportReview,
    workingSessionIds,
  } = dependencies;

  return activePanel === "chat" ? (
    <form
      ref={composerRef}
      className="agent-composer"
      data-hero={heroMode ? "true" : undefined}
      data-drop-active={dropActive ? "true" : undefined}
      onSubmit={(event) => void submit(event)}
      onDragOver={handleComposerDragOver}
      onDragEnter={() => setDropActive(true)}
      onDragLeave={() => setDropActive(false)}
      onDrop={handleComposerDrop}
      onPaste={handleComposerPaste}
    >
      {/* Anchored inside the fixed composer column so it rides the box's
              real height (multi-line drafts, stacked notices) instead of
              guessing a clearance from the card edge. */}
      {heroMode ? null : (
        <AgentScrollToLatestButton scrollRef={agentScrollRef} onJump={scrollTranscriptToLatest} />
      )}
      {textActionsDisabledReason
        ? (renderFundingNotice?.({
            ...textFundingContext,
            onSelectVeniceModel: () => openComposerModelPicker(),
          }) ?? (
            <p className="agent-composer-notice" role="status">
              {textActionsDisabledReason}
            </p>
          ))
        : null}
      <AnimatePresence>
        {galleryErrors ? (
          // Dev gallery only: the busy nudge is a toast in real use (see
          // SESSION_BUSY_TOAST_ID); this renders the old inline pill so
          // __agentErrors can still screenshot that surface.
          <motion.p
            key="busy-notice"
            className="agent-composer-notice"
            role="status"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <DotSpinner />
            {SESSION_BUSY_NOTICE}
          </motion.p>
        ) : visibleIssueReportReview ? (
          <motion.div
            key="issue-report-review"
            className="agent-composer-notice agent-composer-notice-action"
            role="status"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <span>
              {visibleIssueReportReview.report.followUps.length
                ? "Follow-up added. Add more context in chat, or send it to the June team."
                : "Report ready. Add more context in chat, or send it to the June team."}
            </span>
            <button
              type="button"
              className="agent-composer-notice-button"
              disabled={
                visibleIssueReportReview.submitting ||
                visibleIssueReportImportingFiles ||
                visibleIssueReportHasUnsentContext
              }
              onClick={() => void sendReviewableIssueReport(visibleIssueReportReview.sessionId)}
            >
              {visibleIssueReportReview.submitting || visibleIssueReportImportingFiles ? (
                <DotSpinner className="agent-composer-notice-button-spinner" />
              ) : null}
              {visibleIssueReportReview.submitting
                ? "Sending"
                : visibleIssueReportImportingFiles
                  ? "Attaching files"
                  : visibleIssueReportHasUnsentContext
                    ? "Send message first"
                    : "Send report"}
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {visibleFollowUpQueueKey && selectedFollowUpCount ? (
        // One surface for the user's single intent: follow up while June is
        // working. Text may steer the current turn while attachments wait,
        // but that transport distinction belongs in row status, not in two
        // competing queue cards.
        <section className="agent-steer-queue" aria-label="Up next">
          <div className="agent-steer-queue-header">
            <button
              type="button"
              className="agent-steer-queue-trigger"
              aria-expanded={steerQueueOpen}
              onClick={() => setSteerQueueOpen((open) => !open)}
            >
              Up next
              {steerQueueOpen ? null : (
                <span className="status-pill agent-steer-queue-count">{selectedFollowUpCount}</span>
              )}
            </button>
            <button
              type="button"
              className="agent-steer-queue-chevron-button"
              aria-label={steerQueueOpen ? "Collapse up next" : "Expand up next"}
              aria-expanded={steerQueueOpen}
              onClick={() => setSteerQueueOpen((open) => !open)}
            >
              <IconChevronDownSmall
                size={13}
                className="agent-steer-queue-chevron"
                data-expanded={steerQueueOpen}
                aria-hidden
              />
            </button>
          </div>
          {steerQueueOpen ? (
            <div className="agent-steer-cards-scroll scroll-fade" {...steerCardsFade.props}>
              <div ref={steerCardsListRef} className="agent-steer-cards-list">
                {selectedSteerCards.map((card) => renderSteerCard(card))}
                {selectedQueuedAttachmentFollowUps.map((item) =>
                  renderQueuedAttachmentFollowUp(visibleFollowUpQueueKey, item),
                )}
                {selectedUpNextDemoFollowUps.map((item) =>
                  renderQueuedAttachmentFollowUp(visibleFollowUpQueueKey, item, { demo: true }),
                )}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
      <AnimatePresence>
        {showImageModelWarning ? (
          // Docked above the box in the FundingNotice family — same surface
          // recipe, so the pair reads as one floating unit. The warm triangle
          // carries the caution tone.
          <motion.section
            key="image-model-warning"
            className="agent-composer-image-warning"
            role="status"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <span className="agent-composer-image-warning-icon" aria-hidden>
              <IconExclamationTriangle size={14} />
            </span>
            <p className="agent-composer-image-warning-text">{imageModelWarningText}</p>
            {preferredVisionModel ? (
              <div className="agent-composer-image-warning-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    // Switch straight to the preferred image-capable model. The
                    // label promises a one-tap fix, and the generic model picker
                    // isn't vision-scoped — opening it for the multi-candidate
                    // case would drop the user into an unfiltered list that
                    // doesn't surface the eligible models. preferredVisionModel
                    // is pre-filtered to image + tool support and prefers a
                    // suggested pick.
                    void handleSelectGenerationModel(preferredVisionModel.id)
                  }
                >
                  Switch to {preferredVisionModel.name}
                </button>
              </div>
            ) : null}
          </motion.section>
        ) : null}
      </AnimatePresence>
      <div ref={composerBoxRef} className="agent-composer-box">
        {attachments.length ? (
          <div className="agent-composer-attachments">
            {attachments.map((attachment) => (
              <AgentAttachmentTile
                key={attachment.id}
                attachment={attachment}
                onRemove={() => removeAttachment(attachment.id)}
              />
            ))}
          </div>
        ) : null}
        {visibleComposerSizeWarning ? (
          <div className="agent-composer-size-warning" role="status">
            <IconExclamationTriangle
              size={14}
              aria-hidden
              className="agent-composer-size-warning-icon"
            />
            <span className="agent-composer-size-warning-text">
              This message is about{" "}
              {formatComposerTokenCount(visibleComposerSizeWarning.estimatedTokens)} tokens, over{" "}
              {visibleComposerSizeWarning.modelName}'s{" "}
              {formatComposerTokenCount(visibleComposerSizeWarning.contextLimit)} token context
              window.
            </span>
            <span className="agent-composer-size-warning-actions">
              <button
                type="button"
                className="agent-composer-notice-button"
                onClick={proceedWithOversizeComposerInput}
              >
                Proceed
              </button>
              <button
                type="button"
                className="agent-composer-notice-button"
                onClick={editOversizeComposerInput}
              >
                Edit message
              </button>
              {visibleComposerSizeWarning.switchModel ? (
                <button
                  type="button"
                  className="agent-composer-notice-button"
                  onClick={switchOversizeComposerModel}
                >
                  Switch to {visibleComposerSizeWarning.switchModel.name}
                </button>
              ) : null}
            </span>
          </div>
        ) : null}
        <ComposerEditor
          ref={composerEditorRef}
          onFocusChange={onComposerFocusChange}
          skills={skills}
          placeholder={
            generatingVideo
              ? "Generating video…"
              : generatingImage
                ? "Generating image…"
                : importingFiles
                  ? "Attaching file…"
                  : composerInSteerState
                    ? // June is mid-run: a typed message steers this turn
                      // immediately (it is not staged), so the copy names the
                      // outcome - a follow-up folded into the running work -
                      // rather than a queue that doesn't exist.
                      "Ask for follow-up changes"
                    : heroMode
                      ? "Ask June anything, run / commands"
                      : "Send a message"
          }
          onChange={(text, nextCategory) => {
            draftRef.current = text;
            categoryRef.current = nextCategory;
            setDraft(text);
            setCategory(nextCategory);
            if (
              !skills &&
              !skillCommandLoading &&
              text.trimStart().startsWith("/") &&
              !isBuiltinComposerSlashCommand(text)
            ) {
              void loadSkillCommands({ silent: true });
            }
            rememberComposerDraft(
              composerDraftKeyRef.current,
              text,
              nextCategory,
              attachmentsRef.current,
            );
          }}
          onSubmit={() => void submit()}
          onBuiltinSlashCommand={(name) => {
            if (name !== "model") return false;
            // The slash row commits on mousedown. Mounting the palette in
            // that same event lets its window-level outside-click listener
            // observe the now-removed row and close immediately. Queue the
            // palette for the next task, after that pointer or keyboard event.
            window.setTimeout(() => openComposerModelPicker(true), 0);
            return true;
          }}
          onReady={(editor) => {
            composerTiptapEditorRef.current = editor;
            restoreComposerDraft(composerDraftKeyRef.current);
            seedComposerNoteRef({ defer: true });
          }}
        />
        <div className="agent-composer-toolbar">
          <button
            type="button"
            ref={attachTriggerRef}
            className="agent-composer-attach"
            aria-label="Add files, notes, or reports"
            title="Add"
            aria-haspopup="menu"
            aria-expanded={attachMenuOpen}
            data-open={attachMenuOpen || undefined}
            onClick={() => {
              setReportDialogOpen(false);
              setAttachMenuOpen((open) => !open);
            }}
          >
            <IconPlusMedium size={18} />
          </button>
          {heroMode ? (
            // Unrestricted only applies to the session being created, so
            // the picker lives in the hero composer's toolbar and nowhere
            // else. The menu itself renders as a sibling of the box (below)
            // because the box clips its overflow for the FLIP glide.
            <button
              type="button"
              ref={sandboxTriggerRef}
              className="agent-sandbox-trigger"
              data-unrestricted={fullModeDraft ? "true" : undefined}
              aria-haspopup="menu"
              aria-expanded={sandboxMenuOpen}
              title="Change what June can touch"
              onClick={() => setSandboxMenuOpen((open) => !open)}
            >
              {fullModeDraft ? (
                <IconShieldCrossed size={14} aria-hidden />
              ) : (
                <IconShieldCheck size={14} aria-hidden />
              )}
              {fullModeDraft ? "Unrestricted" : "Sandboxed"}
              <IconChevronDownSmall size={12} aria-hidden />
            </button>
          ) : null}
          <div className="agent-composer-actions">
            <ComposerModelPicker
              open={composerModelOpen}
              model={generationModel}
              detail={
                generationModel?.id === AUTO_MODEL_ID
                  ? autoPillDesignation(activeGenerationCostQuality)
                  : undefined
              }
              effort={composerThinkingLevel}
              triggerRef={composerModelTriggerRef}
              onToggleOpen={() => {
                if (composerModelOpen) {
                  setComposerModelOpen(false);
                  return;
                }
                openComposerModelPicker();
              }}
            />
            <button
              type="button"
              className="agent-composer-mic"
              aria-label="Dictate"
              title={creditActionsDisabledReason ?? "Start dictation"}
              disabled={Boolean(creditActionsDisabledReason)}
              onClick={() => void startDictation()}
            >
              <IconMicrophone size={18} />
            </button>
            {selectedHermesSessionId && composerInSteerState ? (
              // June is working (or a follow-up is landing): the slot flips
              // to stop the instant a message fires — no spinner in between.
              // Typing a follow-up swaps stop for a steer-send in place (the
              // same one-slot scale trade every send/stop swap uses), which
              // redirects the run mid-flight (session.steer) without
              // interrupting it. Stop returns when the draft clears, and
              // Escape interrupts the turn at any time.
              draft.trim().length > 0 || attachments.length > 0 ? (
                // Keyed so the swap remounts (button-for-button in one slot
                // would be updated in place) and the scale-in trade plays.
                <button
                  key="steer-send"
                  type="submit"
                  className="agent-composer-send"
                  disabled={imageSlashBlockedByModel}
                  title={
                    imageSlashBlockedByModel
                      ? "Switch to a vision model before using /image."
                      : attachments.length
                        ? "Queue next message"
                        : "Send to steer June"
                  }
                  aria-label={attachments.length ? "Queue next message" : "Send to steer June"}
                >
                  <IconArrowUp size={18} />
                </button>
              ) : (
                <button
                  key="steer-stop"
                  type="button"
                  className="agent-composer-stop"
                  aria-label="Stop June"
                  title={
                    workingSessionIds.has(selectedHermesSessionId)
                      ? "Stop June"
                      : "June is starting"
                  }
                  disabled={
                    stoppingSessionIds.has(selectedHermesSessionId) ||
                    !workingSessionIds.has(selectedHermesSessionId)
                  }
                  onClick={() => void stopHermesSession(selectedHermesSessionId)}
                >
                  <IconStop size={16} />
                </button>
              )
            ) : (
              <button
                type="submit"
                className="agent-composer-send"
                disabled={
                  submitting ||
                  importingFiles ||
                  Boolean(textActionsDisabledReason) ||
                  selectedHermesSessionIsProvisional ||
                  imageSlashBlockedByModel ||
                  (!draft.trim() && !attachments.length)
                }
                title={
                  imageSlashBlockedByModel
                    ? "Switch to a vision model before using /image."
                    : undefined
                }
                aria-label={
                  selectedHermesSessionId || selectedTask ? "Send message" : "Start session"
                }
              >
                {submitting ? <Spinner /> : <IconArrowUp size={18} />}
              </button>
            )}
          </div>
        </div>
      </div>
      {attachMenuOpen ? (
        // Sibling of the box (which clips its overflow for the grow glide),
        // anchored above the "+" trigger by CSS.
        <div
          ref={attachMenuRef}
          className="agent-attach-menu"
          role="menu"
          aria-label="Add files, notes, or reports"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setAttachMenuOpen(false);
              void pickAttachments();
            }}
          >
            <span className="agent-attach-menu-icon">
              <IconFileText size={16} aria-hidden />
            </span>
            <span className="agent-attach-menu-label">Attach files</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setAttachMenuOpen(false);
              const editor = composerTiptapEditorRef.current;
              if (editor && !editor.isDestroyed) {
                // The suggestion plugin only matches a trigger preceded by
                // whitespace or a line start, so pad the "@" when the caret
                // sits right after text or an atom chip.
                const nodeBefore = editor.state.selection.$from.nodeBefore;
                const lastChar = nodeBefore?.isText ? (nodeBefore.text?.slice(-1) ?? "") : "";
                const needsSpace = nodeBefore != null && !/\s/.test(lastChar || "x");
                editor
                  .chain()
                  .focus()
                  .insertContent(needsSpace ? " @" : "@")
                  .run();
              } else {
                composerEditorRef.current?.focus();
              }
            }}
          >
            <span className="agent-attach-menu-icon">
              <IconNoteText size={16} aria-hidden />
            </span>
            <span className="agent-attach-menu-label">Reference a note</span>
          </button>
          <div className="agent-attach-menu-divider" role="separator" />
          {REPORT_CATEGORIES.map((reportCategory) => (
            <button
              key={reportCategory.key}
              type="button"
              role="menuitem"
              onClick={() => {
                openReportDialog(reportCategory.key);
              }}
            >
              <span className="agent-attach-menu-icon" data-category={reportCategory.key}>
                <CategoryIcon category={reportCategory.key} size={16} />
              </span>
              <span className="agent-attach-menu-label">{reportCategory.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {reportDialogOpen ? (
        <ReportDialog
          category={reportDialogCategory}
          description={reportDialogDescription}
          attachments={reportDialogAttachments}
          importingFiles={importingFiles}
          onCategoryChange={setReportDialogCategory}
          onDescriptionChange={setReportDialogDescription}
          onAddFiles={pickReportDialogAttachments}
          onDropFiles={importReportDialogDroppedFiles}
          onRemoveAttachment={removeReportDialogAttachment}
          onClose={() => setReportDialogOpen(false)}
          onSent={handleReportDialogSent}
        />
      ) : null}
      {composerModelOpen ? (
        <ModelPickerPopover
          mode="generation"
          flyout={composerModelFlyout}
          model={generationModel}
          options={modelOptions(generationModelOptions, generationModel?.id ?? "")}
          costQuality={activeGenerationCostQuality}
          veniceApiKeyConfigured={veniceApiKeyConfigured}
          catalogLoaded={generationModelOptions.length > 0}
          search={modelSearch}
          popoverRef={composerModelPopoverRef}
          searchRef={composerModelSearchRef}
          rootSearchRef={composerModelRootSearchRef}
          rootSearch={modelRootSearch}
          onRootSearchChange={(value) => {
            setComposerModelFlyout(null);
            setModelRootSearch(value);
          }}
          onFlyoutChange={setComposerModelFlyout}
          onSearchChange={setModelSearch}
          onSelect={(modelId, costQuality, options) => {
            void handleSelectGenerationModel(modelId, costQuality, options);
            // A final pick closes the popover and hands focus back to the
            // draft; control adjustments (Auto, a keepOpen select) leave
            // the popover and its focus in place.
            if (!options?.keepOpen) composerEditorRef.current?.focus();
          }}
          onCostQualityChange={handleCostQualityChange}
          thinkingLevel={composerThinkingLevel}
          onSelectThinking={(level) => {
            setComposerModelFlyout(null);
            setComposerModelOpen(false);
            void handleSelectThinkingLevel(level);
          }}
        />
      ) : null}
      {heroMode && sandboxMenuOpen ? (
        <div
          ref={sandboxMenuRef}
          className="agent-sandbox-menu"
          role="menu"
          aria-label="What can June change?"
        >
          <p className="agent-sandbox-menu-title">What can June change?</p>
          {SANDBOX_OPTIONS.map((option, index) => (
            <button
              key={option.title}
              ref={index === 0 ? sandboxFirstItemRef : undefined}
              type="button"
              role="menuitemradio"
              aria-checked={fullModeDraft === option.unrestricted}
              onClick={() => {
                setSandboxMenuOpen(false);
                // First arm of the app session goes through the confirm
                // dialog; once acknowledged it arms directly, and going
                // back to sandboxed never asks.
                if (option.unrestricted && !fullModeDraft && !unrestrictedAcknowledged()) {
                  setConfirmUnrestricted(true);
                  return;
                }
                fullModeDraftRef.current = option.unrestricted;
                setFullModeDraft(option.unrestricted);
              }}
            >
              {option.icon}
              <span className="agent-sandbox-option">
                <span className="agent-sandbox-option-title">{option.title}</span>
                <span className="agent-sandbox-option-desc">{option.description}</span>
              </span>
              {fullModeDraft === option.unrestricted ? (
                <IconCheckmark2Small size={16} aria-hidden className="agent-sandbox-option-check" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      <Dialog
        open={confirmUnrestricted}
        onClose={() => setConfirmUnrestricted(false)}
        title="Turn on Unrestricted?"
        description="June will be able to change any file your account can, not just its own workspace. This comes with risks like data loss if something goes wrong."
        footer={
          <>
            <button
              type="button"
              className="primary-action"
              onClick={() => setConfirmUnrestricted(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              onClick={() => {
                rememberUnrestrictedAcknowledged();
                fullModeDraftRef.current = true;
                setFullModeDraft(true);
                setConfirmUnrestricted(false);
              }}
            >
              Turn on Unrestricted
            </button>
          </>
        }
      >
        {null}
      </Dialog>
    </form>
  ) : null;
}
