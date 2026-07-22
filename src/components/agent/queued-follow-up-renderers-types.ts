import { type ComposerEditorHandle } from "./composer/ComposerEditor";
import type { AgentAttachment } from "./agent-workspace-models";
import { type QueuedAttachmentFollowUp } from "./composer/follow-up-queue";
import type * as React from "react";

export type createQueuedFollowUpRenderersDependencies = {
  attachments: AgentAttachment[];
  composerEditorRef: React.MutableRefObject<ComposerEditorHandle | null>;
  deliverQueuedAttachmentFollowUp: (
    queueKey: string,
    itemId?: string,
    options?: { afterCompletion?: boolean },
  ) => Promise<boolean>;
  draft: string;
  draftRef: React.MutableRefObject<string>;
  editQueuedAttachmentFollowUp: (queueKey: string, itemId: string) => void;
  queuedAttachmentFollowUpsRef: React.MutableRefObject<Record<string, QueuedAttachmentFollowUp[]>>;
  removeQueuedAttachmentFollowUp: (queueKey: string, itemId: string) => void;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setUpNextDemoFollowUpsBySessionId: React.Dispatch<
    React.SetStateAction<Record<string, QueuedAttachmentFollowUp[]>>
  >;
  workingSessionIds: Set<string>;
};
