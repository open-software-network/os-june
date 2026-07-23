import type { AgentAttachment, ImageSafeModeConsentEventPayload } from "./agent-workspace-models";

export type UseAgentDropEventsDependencies = {
  handleAgentImageSafeModeConsentEvent: (
    payload?: ImageSafeModeConsentEventPayload,
  ) => Promise<void>;
  importDroppedFilePaths: (
    paths: string[],
    options?: { onImported?: (attachments: AgentAttachment[]) => void },
  ) => Promise<boolean>;
};
