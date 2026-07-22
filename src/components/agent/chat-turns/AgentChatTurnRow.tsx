import { IconArrowsRepeat } from "central-icons/IconArrowsRepeat";
import { IconConcise } from "central-icons/IconConcise";
import { memo, useEffect, useRef, useState } from "react";
import {
  displayedComposerUserMessageText,
  stripRenderedMediaReferences,
  type AgentApprovalChoice,
  type AgentChatPart,
  type AgentChatTurn,
} from "../../../lib/agent-chat-runtime";
import {
  hasAgentCliAccessRequest,
  stripAgentCliAccessRequest,
} from "../../../lib/agent-cli-access";
import { hasBrowserAccessRequest, stripBrowserAccessRequest } from "../../../lib/browser-access";
import { hermesBridgeFilePreview } from "../../../lib/tauri";
import type { FundingTier } from "../../account/FundingNotice";
import { CopyStateIcon } from "../../ui/CopyStateIcon";
import { HoverTip } from "../../ui/HoverTip";
import { relativeDate } from "../agent-workspace-helpers";
import { FileTypeIcon } from "../FileTypeIcon";
import { MarkdownContent } from "../MarkdownContent";
import { SmoothedStreamingMarkdown } from "../SmoothedStreamingMarkdown";
import {
  AgentBrowserAccessCard,
  AgentCliAccessCard,
  ApprovalPart,
  ClarifyPart,
  type AgentBrowserAccessCardProps,
  type AgentCliAccessCardProps,
} from "./AgentActionCards";
import { AgentArtifactList, type AgentArtifact } from "./AgentArtifactPanel";
import {
  BranchFromHereAction,
  SecretPart,
  SudoPart,
  TURN_ACTION_TIP_DELAY_MS,
  branchSourceSessionIdForTurn,
  turnIsConcreteResponse,
} from "./BranchAndSensitiveActions";
import { AgentGeneratedImage, AgentGeneratedVideo } from "./GeneratedMedia";
import {
  ContextOverflowNoticePart,
  CreditsNoticePart,
  SteeringPart,
  UpstreamProviderFailureNoticePart,
} from "./SessionNotices";
import { AgentThinkingGroup, AgentToolStack } from "./ThinkingAndTools";

export type AgentChatTurnRowProps = {
  activeThinkingKey?: string;
  approvalSubmitting: Partial<Record<string, AgentApprovalChoice>>;
  artifacts?: AgentArtifact[];
  clarifySubmitting: Record<string, string>;
  sudoSubmitting: Record<string, "approve" | "deny">;
  secretSubmitting: Record<string, true>;
  /** State + handler for June's in-chat Agent CLI access request card.
   * Optional so the dev gallery can render rows without the live setting. */
  cliAccess?: AgentCliAccessCardProps;
  /** State + handler for June's in-chat Browser use request card. Optional
   * for the same reason. */
  browserAccess?: AgentBrowserAccessCardProps;
  thinkingOpen: (key: string) => boolean;
  onApproval: (
    part: Extract<AgentChatPart, { type: "approval" }>,
    choice: AgentApprovalChoice,
  ) => void;
  onClarify: (part: Extract<AgentChatPart, { type: "clarify" }>, answer: string) => void;
  onSudo: (part: Extract<AgentChatPart, { type: "sudo" }>, approved: boolean) => void;
  onSecret: (part: Extract<AgentChatPart, { type: "secret" }>, value: string) => void;
  onDownloadArtifact?: (artifact: AgentArtifact) => void;
  onOpenArtifact?: (artifact: AgentArtifact) => void;
  /** Save a `/image` result to disk; enlarge it in the file viewer. Optional so
   * the dev gallery can render image rows without the live bridge. */
  onDownloadImage?: (part: Extract<AgentChatPart, { type: "image" }>) => void;
  onOpenImage?: (part: Extract<AgentChatPart, { type: "image" }>) => void;
  onRetryImage?: (assistantTurnId: string, part: Extract<AgentChatPart, { type: "image" }>) => void;
  onDownloadVideo?: (part: Extract<AgentChatPart, { type: "video" }>) => void;
  onRetryVideo?: (assistantTurnId: string, part: Extract<AgentChatPart, { type: "video" }>) => void;
  onRetryUpstreamFailure?: (assistantTurnId: string) => void;
  upstreamFailureRetryAttempted?: boolean;
  upstreamFailureRetryDisabled?: boolean;
  creditActionsDisabledReason?: string;
  onThinkingOpenChange: (key: string, open: boolean) => void;
  onTopUp?: () => void;
  topUpLabel?: string;
  fundingTier?: FundingTier;
  onVisibleMarkdownChange?: (visibleMarkdown: string) => void;
  /** Fork the conversation from this turn into a new session (feature 07).
   * Optional: only Hermes-session rows pass it — task rows and the dev gallery
   * omit it, so the action is absent there. */
  onBranch?: (messageId: string, sessionId?: string) => void;
  /** The message id a branch is currently in flight for, so its action shows a
   * working/disabled state. */
  branchingMessageId?: string | null;
  turn: AgentChatTurn;
};

export const AgentChatTurnRow = memo(function AgentChatTurnRow({
  activeThinkingKey,
  approvalSubmitting,
  artifacts,
  clarifySubmitting,
  sudoSubmitting,
  secretSubmitting,
  cliAccess,
  browserAccess,
  thinkingOpen,
  onApproval,
  onClarify,
  onSudo,
  onSecret,
  onDownloadArtifact,
  onOpenArtifact,
  onDownloadImage,
  onOpenImage,
  onRetryImage,
  onDownloadVideo,
  onRetryVideo,
  onRetryUpstreamFailure,
  upstreamFailureRetryAttempted,
  upstreamFailureRetryDisabled,
  creditActionsDisabledReason,
  onThinkingOpenChange,
  onTopUp,
  topUpLabel,
  fundingTier,
  onVisibleMarkdownChange,
  onBranch,
  branchingMessageId,
  turn,
}: AgentChatTurnRowProps) {
  const textParts = turn.parts.filter(
    (part): part is Extract<AgentChatPart, { type: "text" }> => part.type === "text",
  );
  const reasoningParts = turn.parts.filter(
    (part): part is Extract<AgentChatPart, { type: "reasoning" }> => part.type === "reasoning",
  );
  const toolParts = turn.parts.filter(
    (part): part is Extract<AgentChatPart, { type: "tool" }> => part.type === "tool",
  );
  // A running generation tool holds space with the same placeholder the /image
  // fast path uses, so the result doesn't pop in from nothing when the tool
  // completes and its real image/video part takes over the slot.
  const runningMediaTools = toolParts.filter(
    (part): part is Extract<AgentChatPart, { type: "tool" }> & { media: "image" | "video" } =>
      part.status === "running" && part.media !== undefined,
  );
  const hasGeneratedImage = turn.parts.some((part) => part.type === "image");
  const hasGeneratedVideo = turn.parts.some((part) => part.type === "video");
  // The media canvas owns successful generation from start through result.
  // Keeping the generic tool row alongside it would show two activity states,
  // then make that row pop back in above the finished media. Failed media tools
  // and unrelated tools still render normally.
  const visibleToolParts = toolParts.filter((part) => {
    if (!part.media || part.status === "failed") return true;
    if (part.status === "running") return false;
    return part.media === "image" ? !hasGeneratedImage : !hasGeneratedVideo;
  });
  // The disclosure owns internal reasoning only. Tool/action rows stay visible
  // outside it so users can see what June is doing without expanding Thought;
  // a running media tool is represented by its canvas instead, just above.
  const thinkingRunning = reasoningParts.some((part) => part.status === "running");
  const completedThinkingKey = `turn:${turn.id}:thinking`;
  const thinkingKey =
    thinkingRunning && activeThinkingKey ? activeThinkingKey : completedThinkingKey;
  const wasThinkingRunningRef = useRef(thinkingRunning);
  const carriedOpen =
    !thinkingRunning &&
    wasThinkingRunningRef.current &&
    activeThinkingKey !== undefined &&
    thinkingOpen(activeThinkingKey);
  const thinkingIsOpen = thinkingOpen(thinkingKey) || carriedOpen;
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const wasRunning = wasThinkingRunningRef.current;
    wasThinkingRunningRef.current = thinkingRunning;
    if (
      !wasRunning ||
      thinkingRunning ||
      activeThinkingKey === undefined ||
      reasoningParts.length === 0 ||
      !thinkingOpen(activeThinkingKey)
    ) {
      return;
    }
    onThinkingOpenChange(completedThinkingKey, true);
    onThinkingOpenChange(activeThinkingKey, false);
  }, [
    activeThinkingKey,
    completedThinkingKey,
    onThinkingOpenChange,
    reasoningParts.length,
    thinkingOpen,
    thinkingRunning,
    toolParts.length,
  ]);

  useEffect(
    () => () => {
      if (copyResetTimerRef.current !== undefined) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    },
    [],
  );

  const contextParts = turn.parts.filter(
    (part): part is Extract<AgentChatPart, { type: "context" }> => part.type === "context",
  );
  const attachmentParts = turn.parts.filter(
    (part): part is Extract<AgentChatPart, { type: "attachment" }> => part.type === "attachment",
  );
  const nonTextParts = turn.parts.filter((part) => part.type !== "text");
  const concreteResponse = turnIsConcreteResponse(turn);
  const copyText = copyableTextForTurn(turn);

  async function copyTurn() {
    if (!copyText) return;
    try {
      if (!navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      if (copyResetTimerRef.current !== undefined) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetTimerRef.current = undefined;
      }, 1600);
    } catch {
      // Clipboard can fail in restricted contexts; leave the transcript alone.
    }
  }

  // Per-turn transcript actions. Branch is rendered only on Hermes-session rows
  // (which pass `onBranch`); pending user prompts and live assistant rows route
  // to the nearest saved fork point, while other synthetic rows still explain
  // that they need to be saved first.
  const branchSessionId = branchSourceSessionIdForTurn(turn);
  const branchMessageId = turn.branchMessageId ?? turn.id;
  const branchSubmitting = branchingMessageId === branchMessageId;
  const branchAction = onBranch ? (
    <BranchFromHereAction
      messageId={branchMessageId}
      sessionId={branchSessionId}
      onBranch={onBranch}
      submitting={branchSubmitting}
    />
  ) : null;
  const copyAction = copyText ? (
    <HoverTip
      compact
      width={104}
      delay={TURN_ACTION_TIP_DELAY_MS}
      tip={copied ? "Copied" : "Copy message"}
      forceOpen={copied}
      className="agent-turn-action-tip"
    >
      <button
        type="button"
        className="agent-turn-action"
        aria-label={copied ? "Copied message" : "Copy message"}
        data-copied={copied ? "true" : undefined}
        onClick={() => void copyTurn()}
      >
        <CopyStateIcon copied={copied} />
      </button>
    </HoverTip>
  ) : null;
  // Timestamp for the row. relativeDate returns "" for an unparseable value, so
  // we only render the <time> when there's a real date to show.
  const timestampLabel = relativeDate(turn.createdAt);
  const timestampAction = timestampLabel ? (
    <HoverTip
      compact
      width={200}
      delay={TURN_ACTION_TIP_DELAY_MS}
      tip={new Date(turn.createdAt).toLocaleString()}
      className="agent-turn-action-tip"
    >
      <time className="agent-turn-timestamp" dateTime={turn.createdAt}>
        {timestampLabel}
      </time>
    </HoverTip>
  ) : null;
  const turnActions =
    concreteResponse && (copyAction || branchAction || timestampAction) ? (
      <div className="agent-turn-actions" data-branching={branchSubmitting ? "true" : undefined}>
        <div className="agent-turn-actions-inner">
          {/* The timestamp sits on the outer/far side of the row: before the
           * icons on right-aligned user turns, after them on left-aligned
           * assistant turns, so the icons always stay nearest the message. */}
          {turn.role === "user" ? timestampAction : null}
          {copyAction}
          {branchAction}
          {turn.role === "user" ? null : timestampAction}
        </div>
      </div>
    ) : null;

  if (contextParts.length && turn.parts.every((part) => part.type === "context")) {
    return (
      <>
        {contextParts.map((part, index) => (
          <ContextCompactionPart key={`${turn.id}:context:${index}`} part={part} />
        ))}
      </>
    );
  }

  if (turn.role === "user") {
    return (
      <article
        className="agent-user-turn"
        data-scheduled-run={turn.isScheduledRun ? "true" : undefined}
      >
        {turn.isScheduledRun ? (
          <span className="agent-user-turn-eyebrow">
            <IconArrowsRepeat size={12} aria-hidden />
            Scheduled routine run
          </span>
        ) : null}
        <div className="agent-user-turn-body">
          {textParts.map((part, index) => {
            const markdown = displayedComposerUserMessageText(part.text);
            return markdown ? (
              <MarkdownContent
                key={`${turn.id}:text:${index}`}
                // Issue-report sessions open with the wrapped investigation
                // prompt; the transcript shows only what the user typed.
                markdown={markdown}
              />
            ) : null;
          })}
          {attachmentParts.length ? (
            <AgentUserAttachmentList attachments={attachmentParts} onOpen={onOpenArtifact} />
          ) : null}
        </div>
        {turnActions}
      </article>
    );
  }

  return (
    <article className="agent-assistant-turn" data-status={turn.status}>
      <div className="agent-assistant-turn-body">
        {reasoningParts.length > 0 ? (
          <AgentThinkingGroup
            reasoning={reasoningParts}
            running={thinkingRunning}
            open={thinkingIsOpen}
            onOpenChange={(open) => onThinkingOpenChange(thinkingKey, open)}
          />
        ) : null}
        {visibleToolParts.length > 0 ? <AgentToolStack parts={visibleToolParts} /> : null}
        {runningMediaTools.map((tool) =>
          tool.media === "image" ? (
            <AgentGeneratedImage
              key={`generating:${tool.id}`}
              part={{ type: "image", status: "running", prompt: "" }}
            />
          ) : (
            <AgentGeneratedVideo
              key={`generating:${tool.id}`}
              part={{ type: "video", status: "running", prompt: "" }}
            />
          ),
        )}
        {turn.parts.map((part, index) =>
          part.type === "text" ? (
            hasAgentCliAccessRequest(part.text) || hasBrowserAccessRequest(part.text) ? (
              // June's soul emits a literal token to request the Agent CLI
              // access or Browser use setting; each token renders as an
              // approval card, never as text. A reply carrying both tokens
              // gets both cards.
              <div key={`${turn.id}:text:${index}`}>
                {stripBrowserAccessRequest(stripAgentCliAccessRequest(part.text)) ? (
                  <MarkdownContent
                    markdown={stripBrowserAccessRequest(stripAgentCliAccessRequest(part.text))}
                    repairProse
                  />
                ) : null}
                {hasAgentCliAccessRequest(part.text) ? (
                  <AgentCliAccessCard cliAccess={cliAccess} />
                ) : null}
                {hasBrowserAccessRequest(part.text) ? (
                  <AgentBrowserAccessCard browserAccess={browserAccess} />
                ) : null}
              </div>
            ) : (
              <div key={`${turn.id}:text:${index}`}>
                {/* A part can retain raw MEDIA deltas while streaming or when
                    a terminal/error event arrives without message.complete.
                    Those transport references never belong in assistant prose. */}
                <SmoothedStreamingMarkdown
                  markdown={stripRenderedMediaReferences(part.text, part.status === "running")}
                  running={part.status === "running"}
                  repairProse
                  onVisibleMarkdownChange={onVisibleMarkdownChange}
                />
              </div>
            )
          ) : part.type === "context" ? (
            <ContextCompactionPart key={`${turn.id}:context:${index}`} part={part} />
          ) : part.type === "approval" ? (
            <ApprovalPart
              key={`${turn.id}:approval:${part.id}`}
              part={part}
              submitting={approvalSubmitting[part.id]}
              onApproval={onApproval}
            />
          ) : part.type === "clarify" ? (
            <ClarifyPart
              key={`${turn.id}:clarify:${part.id}`}
              part={part}
              submitting={clarifySubmitting[part.id]}
              onClarify={onClarify}
            />
          ) : part.type === "sudo" ? (
            <SudoPart
              key={`${turn.id}:sudo:${part.id}`}
              part={part}
              submitting={sudoSubmitting[part.id]}
              onSudo={onSudo}
            />
          ) : part.type === "secret" ? (
            <SecretPart
              key={`${turn.id}:secret:${part.id}`}
              part={part}
              submitting={secretSubmitting[part.id]}
              onSecret={onSecret}
            />
          ) : part.type === "notice" ? (
            part.kind === "context-overflow" ? (
              <ContextOverflowNoticePart key={`${turn.id}:notice:${index}`} />
            ) : part.kind === "upstream-provider" ? (
              <UpstreamProviderFailureNoticePart
                key={`${turn.id}:notice:${index}`}
                attempted={upstreamFailureRetryAttempted}
                disabled={upstreamFailureRetryDisabled}
                onRetry={onRetryUpstreamFailure ? () => onRetryUpstreamFailure(turn.id) : undefined}
              />
            ) : (
              <CreditsNoticePart
                key={`${turn.id}:notice:${index}`}
                onTopUp={onTopUp}
                topUpLabel={topUpLabel}
                tier={fundingTier}
              />
            )
          ) : part.type === "steering" ? (
            <SteeringPart key={`${turn.id}:steering:${index}`} part={part} />
          ) : part.type === "image" ? (
            <AgentGeneratedImage
              key={`${turn.id}:image:${index}`}
              part={part}
              onOpen={onOpenImage}
              onDownload={onDownloadImage}
              onRetry={onRetryImage ? () => onRetryImage(turn.id, part) : undefined}
            />
          ) : part.type === "video" ? (
            <AgentGeneratedVideo
              key={`${turn.id}:video:${index}`}
              part={part}
              onDownload={onDownloadVideo}
              onRetry={onRetryVideo ? () => onRetryVideo(turn.id, part) : undefined}
              retryDisabledReason={part.jobId ? undefined : creditActionsDisabledReason}
            />
          ) : null,
        )}
        <AgentArtifactList
          artifacts={artifacts ?? []}
          onDownload={onDownloadArtifact}
          onOpen={onOpenArtifact}
        />
        {textParts.length === 0 && nonTextParts.length === 0 ? (
          <p className="agent-assistant-empty">
            <span className="text-shimmer shimmer">Thinking…</span>
          </p>
        ) : (
          // No actions on an empty/in-flight turn. There is nothing useful to
          // copy or fork from yet.
          turnActions
        )}
      </div>
    </article>
  );
});

function AgentUserAttachmentList({
  attachments,
  onOpen,
}: {
  attachments: Extract<AgentChatPart, { type: "attachment" }>[];
  onOpen?: (artifact: AgentArtifact) => void;
}) {
  return (
    <div className="agent-user-attachments" role="group" aria-label="Attachments">
      {attachments.map((attachment) => (
        <AgentUserAttachment key={attachment.path} attachment={attachment} onOpen={onOpen} />
      ))}
    </div>
  );
}

function AgentUserAttachment({
  attachment,
  onOpen,
}: {
  attachment: Extract<AgentChatPart, { type: "attachment" }>;
  onOpen?: (artifact: AgentArtifact) => void;
}) {
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (attachment.kind !== "image") return;
    let cancelled = false;
    hermesBridgeFilePreview(attachment.path)
      .then((dataUrl) => {
        if (!cancelled) setPreviewDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setPreviewDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.kind, attachment.path]);

  const artifact: AgentArtifact = {
    name: attachment.name,
    path: attachment.path,
    rootLabel: "Workspace",
  };
  const content =
    attachment.kind === "image" ? (
      previewDataUrl ? (
        <img src={previewDataUrl} alt="" aria-hidden="true" draggable={false} />
      ) : previewDataUrl === undefined ? (
        <span className="agent-user-attachment-loading text-shimmer shimmer">Loading image...</span>
      ) : (
        <>
          <span className="agent-attachment-file-icon" aria-hidden="true">
            <FileTypeIcon name={attachment.name} size={18} />
          </span>
          <span className="agent-user-attachment-name">{attachment.name}</span>
        </>
      )
    ) : (
      <>
        <span className="agent-attachment-file-icon" aria-hidden="true">
          <FileTypeIcon name={attachment.name} size={18} />
        </span>
        <span className="agent-user-attachment-name">{attachment.name}</span>
      </>
    );

  return onOpen ? (
    <button
      type="button"
      className="agent-user-attachment"
      data-kind={attachment.kind}
      aria-label={`Open ${attachment.name}`}
      title={attachment.name}
      onClick={() => onOpen(artifact)}
    >
      {content}
    </button>
  ) : (
    <div className="agent-user-attachment" data-kind={attachment.kind} title={attachment.name}>
      {content}
    </div>
  );
}

export function copyableTextForTurn(turn: AgentChatTurn): string {
  if (turn.role === "user") return userPromptTextForTurn(turn);
  if (turn.role !== "assistant") return "";
  return turn.parts
    .filter((part): part is Extract<AgentChatPart, { type: "text" }> => part.type === "text")
    .map((part) => stripBrowserAccessRequest(stripAgentCliAccessRequest(part.text)).trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function userPromptTextForTurn(turn: AgentChatTurn): string {
  return turn.parts
    .filter((part): part is Extract<AgentChatPart, { type: "text" }> => part.type === "text")
    .map((part) => displayedComposerUserMessageText(part.text).trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function ContextCompactionPart({ part }: { part: Extract<AgentChatPart, { type: "context" }> }) {
  return (
    <details className="agent-context-summary">
      <summary>
        {/* Same hover affordance as the tool rows: the glyph cross-fades to a
         * plain-text "+"/"−" so the row reads as one quiet, expandable line.
         * IconConcise (thinned via CSS) marks the squeeze of compaction. No
         * timestamp: this is a system marker, not a concrete message. */}
        <span className="agent-tool-icon">
          <IconConcise size={15} className="agent-context-icon-glyph" />
          <span className="agent-tool-icon-expand">+</span>
          <span className="agent-tool-icon-minimize">−</span>
        </span>
        <span className="agent-context-label">Context compacted</span>
      </summary>
      <MarkdownContent markdown={part.text} />
    </details>
  );
}
