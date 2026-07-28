import { isLoopbackUrl } from "./local-generation";
import type { LocalTranscriptionSettingsDto } from "./tauri";

type DraftRehydrationDecision = {
  rehydrate: boolean;
  matchesPendingSave: boolean;
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function hasCompleteLocalTranscriptionEndpoint(baseUrl: string, modelId: string): boolean {
  return baseUrl.trim().length > 0 && modelId.trim().length > 0;
}

export function localTranscriptionDraftRehydration(args: {
  pendingSave: LocalTranscriptionSettingsDto | null;
  incoming: LocalTranscriptionSettingsDto;
  currentDraft: LocalTranscriptionSettingsDto;
}): DraftRehydrationDecision {
  const { pendingSave, incoming, currentDraft } = args;
  if (!pendingSave) {
    return { rehydrate: true, matchesPendingSave: false };
  }
  const matchesPendingSave =
    normalizeBaseUrl(pendingSave.baseUrl) === normalizeBaseUrl(incoming.baseUrl) &&
    pendingSave.modelId.trim() === incoming.modelId.trim() &&
    pendingSave.apiKey.trim() === incoming.apiKey.trim();
  if (!matchesPendingSave) {
    return { rehydrate: true, matchesPendingSave: false };
  }
  const draftEditedDuringSave =
    normalizeBaseUrl(currentDraft.baseUrl) !== normalizeBaseUrl(pendingSave.baseUrl) ||
    currentDraft.modelId.trim() !== pendingSave.modelId.trim() ||
    currentDraft.apiKey.trim() !== pendingSave.apiKey.trim();
  return { rehydrate: !draftEditedDuringSave, matchesPendingSave: true };
}

export type PendingLocalTranscriptionSave = {
  seq: number;
  sent: LocalTranscriptionSettingsDto;
} | null;

export type LocalTranscriptionSaveSerializer = <T>(run: () => Promise<T>) => Promise<T>;

export function makeLocalTranscriptionSaveSerializer(): LocalTranscriptionSaveSerializer {
  let chain: Promise<unknown> = Promise.resolve();
  return function enqueueSave<T>(run: () => Promise<T>): Promise<T> {
    const previous = chain;
    const result = previous.then(run, run);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export type LocalTranscriptionSaveReconciliation =
  | { kind: "drop" }
  | {
      kind: "apply";
      preserveEdits: boolean;
      matchesPendingSave: boolean;
      clearPending: boolean;
    };

export function reconcileLocalTranscriptionSaveResponse(args: {
  pending: PendingLocalTranscriptionSave;
  responseSeq: number;
  responseSettings: LocalTranscriptionSettingsDto;
  currentDraft: LocalTranscriptionSettingsDto;
}): LocalTranscriptionSaveReconciliation {
  const { pending, responseSeq, responseSettings, currentDraft } = args;
  if (!pending || pending.seq < responseSeq) {
    return { kind: "drop" };
  }
  const decision = localTranscriptionDraftRehydration({
    pendingSave: pending.sent,
    incoming: responseSettings,
    currentDraft,
  });
  if (pending.seq > responseSeq) {
    return {
      kind: "apply",
      preserveEdits: true,
      matchesPendingSave: decision.matchesPendingSave,
      clearPending: false,
    };
  }
  return {
    kind: "apply",
    preserveEdits: decision.matchesPendingSave && !decision.rehydrate,
    matchesPendingSave: decision.matchesPendingSave,
    clearPending: true,
  };
}

export type LocalTranscriptionToggleState = {
  enabled: boolean;
  savedBaseUrl: string;
  draftBaseUrl: string;
  draftModelId: string;
};

export type ToggleOnDecision =
  | { kind: "incomplete" }
  | { kind: "loopback-enable" }
  | { kind: "require-confirm" };

export function decideToggleOn(state: LocalTranscriptionToggleState): ToggleOnDecision {
  if (!hasCompleteLocalTranscriptionEndpoint(state.draftBaseUrl, state.draftModelId)) {
    return { kind: "incomplete" };
  }
  if (isLoopbackUrl(state.draftBaseUrl.trim())) {
    return { kind: "loopback-enable" };
  }
  return { kind: "require-confirm" };
}

export type PickerEnableDecision = { kind: "enable-saved" } | { kind: "require-confirm" };

export function decidePickerEnable(args: {
  pendingSave: PendingLocalTranscriptionSave;
  savedBaseUrl: string;
}): PickerEnableDecision {
  if (args.pendingSave) {
    return { kind: "require-confirm" };
  }
  return isLoopbackUrl(args.savedBaseUrl.trim())
    ? { kind: "enable-saved" }
    : { kind: "require-confirm" };
}

export type SaveModelDecision =
  | { kind: "save" }
  | { kind: "require-confirm" }
  | { kind: "blocked-incomplete" };

export function decideSaveModel(state: LocalTranscriptionToggleState): SaveModelDecision {
  if (!hasCompleteLocalTranscriptionEndpoint(state.draftBaseUrl, state.draftModelId)) {
    return { kind: "blocked-incomplete" };
  }
  const savedLoopback = isLoopbackUrl(state.savedBaseUrl.trim());
  const draftLoopback = isLoopbackUrl(state.draftBaseUrl.trim());
  if (state.enabled && savedLoopback && !draftLoopback) {
    return { kind: "require-confirm" };
  }
  return { kind: "save" };
}

export function draftStillMatchesSent(
  sent: LocalTranscriptionSettingsDto,
  currentDraft: LocalTranscriptionSettingsDto,
): boolean {
  return (
    normalizeBaseUrl(sent.baseUrl) === normalizeBaseUrl(currentDraft.baseUrl) &&
    sent.modelId.trim() === currentDraft.modelId.trim() &&
    sent.apiKey.trim() === currentDraft.apiKey.trim()
  );
}

export type ConfirmEnableDecision =
  | { kind: "incomplete" }
  | { kind: "enable-saved" }
  | { kind: "save-draft-then-enable" };

export function decideConfirmEnable(args: {
  fromPicker: boolean;
  savedBaseUrl: string;
  savedModelId: string;
  draftBaseUrl: string;
  draftModelId: string;
}): ConfirmEnableDecision {
  if (args.fromPicker) {
    if (!hasCompleteLocalTranscriptionEndpoint(args.savedBaseUrl, args.savedModelId)) {
      return { kind: "incomplete" };
    }
    return { kind: "enable-saved" };
  }
  if (!hasCompleteLocalTranscriptionEndpoint(args.draftBaseUrl, args.draftModelId)) {
    return { kind: "incomplete" };
  }
  return { kind: "save-draft-then-enable" };
}
