import type { HermesAttachmentState } from "../../lib/hermes-image-attach";
import type { ImportedHermesFile } from "../../lib/tauri";

export type AgentAttachment = ImportedHermesFile & {
  id: string;
  /** Original `/image` prompt for hidden fast-path context handoff. */
  sourcePrompt?: string;
  /** Ephemeral image data for hidden `/image` fast-path holds. Kept out of
   * visible composer state, artifacts, and traces; cleared with the hold after
   * the next successful prompt submit. */
  attachDataUrl?: string;
  /** Structured attach status (feature 19). Tracks whether this import has been
   * sent to the model via image.attach_bytes: imported (ready) → attached (acked) →
   * or failed. Carries file refs only, never the image bytes. Files stay
   * `imported` (they only ride along as a path in the prompt). */
  attach: HermesAttachmentState;
};
