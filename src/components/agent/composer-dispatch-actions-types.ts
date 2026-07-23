import { type HermesSessionDispatchReservation } from "../../lib/hermes-session-dispatch-mutex";
import { type PendingAttachmentPreparation } from "./composer/follow-up-queue";
import type * as React from "react";
import type {
  ImageSafeModeConsentChoice,
  ImageSafeModeConsentRequest,
} from "./agent-workspace-models";

export type createComposerDispatchActionsDependencies = {
  activeComposerDispatchReservationsRef: React.MutableRefObject<
    Map<HermesSessionDispatchReservation, string>
  >;
  completedAgentRunAwaitingAttachmentPreparationRef: React.MutableRefObject<Set<string>>;
  continueAfterCompletedAgentRun: (storedSessionId: string, source?: symbol) => void;
  imageSafeModeConsentRequestRef: React.MutableRefObject<ImageSafeModeConsentRequest | null>;
  invalidatedComposerDispatchReservationsRef: React.MutableRefObject<
    WeakSet<HermesSessionDispatchReservation>
  >;
  pendingAttachmentPreparationsRef: React.MutableRefObject<
    Record<string, Map<number, PendingAttachmentPreparation>>
  >;
  resolveImageSafeModeConsent: (choice: ImageSafeModeConsentChoice) => void;
};
