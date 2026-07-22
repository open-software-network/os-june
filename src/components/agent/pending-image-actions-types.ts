import type { AgentAttachment } from "./agent-workspace-models";
import type * as React from "react";

export type createPendingImageActionsDependencies = {
  pendingFastPathImagesRef: React.MutableRefObject<Record<string, AgentAttachment[]>>;
  setComposerAttachments: (
    nextValue: AgentAttachment[] | ((current: AgentAttachment[]) => AgentAttachment[]),
  ) => void;
};
