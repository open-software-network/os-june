import { useEffect } from "react";
import { AGENT_GALLERY_EVENT, type AgentGalleryDetail } from "../../lib/agent-events";
import { buildAgentChatGallery, buildAgentErrorGallery } from "../../lib/agent-chat-gallery";
import { galleryDesired } from "./agent-dev-tools";
import type { UseAgentGalleryEventsDependencies } from "./use-agent-gallery-events-types";

export function useAgentGalleryEvents(dependencies: UseAgentGalleryEventsDependencies) {
  const { setGalleryErrors, setGallerySections } = dependencies;

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const apply = (show: boolean, errors: boolean) => {
      setGallerySections(
        show ? (errors ? buildAgentErrorGallery() : buildAgentChatGallery()) : null,
      );
      setGalleryErrors(show && errors);
    };
    apply(Boolean(galleryDesired), galleryDesired === "errors");
    const onGallery = (event: Event) => {
      const detail = (event as CustomEvent<AgentGalleryDetail>).detail;
      apply(Boolean(detail?.show), Boolean(detail?.errors));
    };
    window.addEventListener(AGENT_GALLERY_EVENT, onGallery);
    return () => window.removeEventListener(AGENT_GALLERY_EVENT, onGallery);
  }, []);
}
