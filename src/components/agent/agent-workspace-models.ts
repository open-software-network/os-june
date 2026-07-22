import type { HermesAttachmentState } from "../../lib/hermes-image-attach";
import type { ImportedHermesFile } from "../../lib/tauri";
import type { HermesSessionDispatchReservation } from "../../lib/hermes-session-dispatch-mutex";

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

export type ImageSafeModeConsentChoice =
  | { action: "keep"; dontAskAgain: boolean }
  | { action: "turnOff"; dontAskAgain: boolean }
  | { action: "dismiss" };

export type ImageSafeModeConsentRequest = {
  variant: "slash" | "agent" | "video-slash";
  ownerDispatchReservation?: HermesSessionDispatchReservation;
  resolve: (choice: ImageSafeModeConsentChoice) => void;
};

export type ImageSafeModeConsentEventPayload = {
  source?: string;
  prompt?: string;
};

export type AgentDeleteSessionDetail = {
  sessionId: string;
};
