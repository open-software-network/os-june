import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { IconArrowCornerDownRight } from "central-icons/IconArrowCornerDownRight";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconFiles } from "central-icons/IconFiles";
import { IconPencil } from "central-icons/IconPencil";
import { type QueuedAttachmentFollowUp } from "./composer/follow-up-queue";
import { NEW_SESSION_RECOVERY_QUEUE_KEY } from "./agent-session-continuity";
import { AgentAttachmentTile } from "./agent-workspace-support";
import type { createQueuedFollowUpRenderersDependencies } from "./queued-follow-up-renderers-types";

export function createQueuedFollowUpRenderers(
  dependencies: createQueuedFollowUpRenderersDependencies,
) {
  const {
    attachments,
    composerHasContent,
    composerEditorRef,
    deliverQueuedAttachmentFollowUp,
    draftRef,
    editQueuedAttachmentFollowUp,
    queuedAttachmentFollowUpsRef,
    removeQueuedAttachmentFollowUp,
    setDraft,
    setUpNextDemoFollowUpsBySessionId,
    workingSessionIds,
  } = dependencies;

  function renderSteerCard(card: { id: string; text: string }) {
    return (
      <div key={card.id} className="agent-follow-up-row" data-kind="steer">
        <span className="agent-follow-up-icon" aria-hidden>
          <IconArrowCornerDownRight size={13} />
        </span>
        <span className="agent-follow-up-copy">
          <span className="agent-follow-up-text" title={card.text}>
            {card.text}
          </span>
        </span>
      </div>
    );
  }

  function renderQueuedAttachmentFollowUp(
    queueKey: string,
    item: QueuedAttachmentFollowUp,
    options: { demo?: boolean } = {},
  ) {
    const sessionWorking =
      options.demo ||
      (queueKey !== NEW_SESSION_RECOVERY_QUEUE_KEY && workingSessionIds.has(queueKey));
    const firstInQueue = queuedAttachmentFollowUpsRef.current[queueKey]?.[0]?.id === item.id;
    const hasAttachedImage = item.attachments.some(
      (attachment) => attachment.attach.kind === "image" && attachment.attach.status === "attached",
    );
    const locallyEditable = item.status !== "sending" && !hasAttachedImage;
    const editable = locallyEditable && !composerHasContent && attachments.length === 0;
    const statusLabel =
      item.status === "sending"
        ? "Sending"
        : item.status === "failed"
          ? hasAttachedImage
            ? "Image attached; message not sent"
            : "Couldn't send"
          : sessionWorking
            ? "Waiting for June to finish"
            : "Ready to send";
    return (
      <div
        key={item.id}
        className="agent-follow-up-row"
        data-kind="attachment"
        data-status={item.status}
        title={item.error ?? undefined}
      >
        {item.attachments.length ? (
          <div className="agent-follow-up-attachments">
            {item.attachments.length > 1 ? (
              <span className="agent-attachment-chip" data-kind="file" aria-hidden>
                <span className="agent-attachment-file-icon">
                  <IconFiles size={14} />
                </span>
              </span>
            ) : (
              item.attachments
                .slice(0, 1)
                .map((attachment) => (
                  <AgentAttachmentTile key={attachment.id} attachment={attachment} />
                ))
            )}
          </div>
        ) : (
          <span className="agent-follow-up-icon" aria-hidden>
            <IconArrowCornerDownRight size={13} />
          </span>
        )}
        <div className="agent-follow-up-copy">
          <span className="agent-follow-up-text">{item.prepared.typedMessage || "Attachment"}</span>
          <span className="agent-follow-up-announcement" aria-live="polite">
            {statusLabel}
          </span>
          {item.error ? <span className="agent-follow-up-announcement">{item.error}</span> : null}
        </div>
        {item.status === "sending" ? null : (
          <div className="agent-follow-up-actions">
            {item.status === "failed" && firstInQueue ? (
              <button
                type="button"
                aria-label="Retry queued message"
                title="Retry"
                disabled={sessionWorking}
                onClick={() => void deliverQueuedAttachmentFollowUp(queueKey, item.id)}
              >
                <IconArrowRotateClockwise size={14} />
              </button>
            ) : !sessionWorking && firstInQueue ? (
              <button
                type="button"
                aria-label="Send queued message"
                title="Send now"
                onClick={() => void deliverQueuedAttachmentFollowUp(queueKey, item.id)}
              >
                <IconArrowUp size={14} />
              </button>
            ) : null}
            {locallyEditable ? (
              <>
                <button
                  type="button"
                  aria-label="Edit queued message"
                  title={editable ? "Edit" : "Clear the composer before editing"}
                  disabled={!editable}
                  onClick={() => {
                    if (options.demo) {
                      setUpNextDemoFollowUpsBySessionId((current) => ({
                        ...current,
                        [queueKey]: (current[queueKey] ?? []).filter(
                          (followUp) => followUp.id !== item.id,
                        ),
                      }));
                      draftRef.current = item.prepared.typedMessage;
                      setDraft(item.prepared.typedMessage);
                      composerEditorRef.current?.setContent(item.prepared.typedMessage);
                      return;
                    }
                    editQueuedAttachmentFollowUp(queueKey, item.id);
                  }}
                >
                  <IconPencil size={14} />
                </button>
                <button
                  type="button"
                  aria-label="Remove queued message"
                  title="Remove"
                  onClick={() =>
                    options.demo
                      ? setUpNextDemoFollowUpsBySessionId((current) => ({
                          ...current,
                          [queueKey]: (current[queueKey] ?? []).filter(
                            (followUp) => followUp.id !== item.id,
                          ),
                        }))
                      : removeQueuedAttachmentFollowUp(queueKey, item.id)
                  }
                >
                  <IconTrashCan size={14} />
                </button>
              </>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  return {
    renderSteerCard,
    renderQueuedAttachmentFollowUp,
  };
}
