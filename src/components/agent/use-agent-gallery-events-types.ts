import { type AgentChatGallerySection } from "../../lib/agent-chat-gallery";
import type * as React from "react";

export type UseAgentGalleryEventsDependencies = {
  setGalleryErrors: React.Dispatch<React.SetStateAction<boolean>>;
  setGallerySections: React.Dispatch<React.SetStateAction<AgentChatGallerySection[] | null>>;
};
