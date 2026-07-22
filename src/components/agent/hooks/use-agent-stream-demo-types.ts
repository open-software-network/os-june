import { type AgentChatGallerySection } from "../../../lib/agent-chat-gallery";
import type * as React from "react";

export type useAgentStreamDemoDependencies = {
  setGallerySections: React.Dispatch<React.SetStateAction<AgentChatGallerySection[] | null>>;
};
