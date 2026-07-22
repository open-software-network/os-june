import { hermesModelIdForSelection, type SessionModelSelection } from "../../../lib/hermes-session-model-selection";
import { AUTO_MODEL_ID } from "../../settings/ModelPickerDialog";
import type { HermesSessionDispatchReservation } from "../../../lib/hermes-session-dispatch-mutex";
import type { AgentAttachment } from "../agent-workspace-models";

export type PreparedComposerSubmission = {
  displayContent: string;
  runtimeContent: string;
  titleContent: string;
  typedMessage: string;
};

export type CapturedSessionModelTarget = {
  /** Null means this Send starts a new session. */
  targetStoredSessionId: string | null;
  existingHermesModelId?: string;
  selection: SessionModelSelection;
  hermesModelId: string;
  revision?: number;
  shouldApply: boolean;
  globalIntentRevision: number;
};

export function sameSessionModelSelection(
  left: SessionModelSelection,
  right: SessionModelSelection,
): boolean {
  return left.modelId === right.modelId && left.costQuality === right.costQuality;
}

export type QueuedAttachmentFollowUp = {
  id: string;
  prepared: PreparedComposerSubmission;
  attachments: AgentAttachment[];
  modelTarget: CapturedSessionModelTarget;
  dispatchReservation?: HermesSessionDispatchReservation;
  dispatchOrder?: number;
  status: "queued" | "sending" | "failed";
  error?: string;
};

export type PendingSteer = {
  text: string;
  accepted: boolean;
  toolDrained: boolean;
  modelTarget: CapturedSessionModelTarget;
  dispatchReservation?: HermesSessionDispatchReservation;
  dispatchOrder: number;
};

export type PendingAttachmentPreparation = {
  dispatchOrder: number;
  dispatchReservation?: HermesSessionDispatchReservation;
  cancelled: boolean;
};

const UP_NEXT_DEMO_IMAGE_PREVIEW =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='44' height='44'%3E%3Crect width='44' height='44' rx='8' fill='%23d8d5ee'/%3E%3Ccircle cx='17' cy='17' r='7' fill='%237a70ba'/%3E%3C/svg%3E";

function buildUpNextDemoImageAttachment(id: string, name: string): AgentAttachment {
  return {
    id,
    name,
    path: `uploads/${name}`,
    rootLabel: "Hermes workspace",
    size: 24_576,
    previewDataUrl: UP_NEXT_DEMO_IMAGE_PREVIEW,
    attach: {
      localId: id,
      kind: "image",
      displayName: name,
      workspacePath: `uploads/${name}`,
      status: "imported",
    },
  };
}

function buildUpNextDemoFileAttachment(id: string, name: string): AgentAttachment {
  return {
    id,
    name,
    path: `uploads/${name}`,
    rootLabel: "Hermes workspace",
    size: 182_400,
    attach: {
      localId: id,
      kind: "file",
      displayName: name,
      workspacePath: `uploads/${name}`,
      status: "imported",
    },
  };
}

function buildUpNextDemoPrepared(text: string): PreparedComposerSubmission {
  return { displayContent: text, runtimeContent: text, titleContent: text, typedMessage: text };
}

const UP_NEXT_DEMO_MODEL_TARGET: CapturedSessionModelTarget = {
  targetStoredSessionId: null,
  selection: { modelId: AUTO_MODEL_ID, costQuality: 100 },
  hermesModelId: hermesModelIdForSelection({ modelId: AUTO_MODEL_ID, costQuality: 100 }),
  shouldApply: false,
  globalIntentRevision: 0,
};

// Every follow-up shape the queue can hold: a single-image message and a
// multi-attachment message led by a file, so the tile well, the thumbnail,
// and the overflow count all render at once.
export function buildUpNextDemoFollowUps(): QueuedAttachmentFollowUp[] {
  return [
    {
      id: "attachment-follow-up-demo",
      prepared: buildUpNextDemoPrepared("Review this attachment next"),
      attachments: [buildUpNextDemoImageAttachment("attachment-demo-image", "reference.png")],
      modelTarget: UP_NEXT_DEMO_MODEL_TARGET,
      status: "queued",
    },
    {
      id: "attachment-follow-up-demo-multi",
      prepared: buildUpNextDemoPrepared("Fold these findings into the report"),
      attachments: [
        buildUpNextDemoFileAttachment("attachment-demo-file", "usability-findings.pdf"),
        buildUpNextDemoImageAttachment("attachment-demo-image-2", "session-notes.png"),
        buildUpNextDemoImageAttachment("attachment-demo-image-3", "heatmap.png"),
      ],
      modelTarget: UP_NEXT_DEMO_MODEL_TARGET,
      status: "queued",
    },
  ];
}
