import type { CompanionFrontendRequest } from "./tauri";

export const COMPANION_FRONTEND_QUEUE_EVENT = "june:companion-frontend-queue";

const queuedRequests = new Map<string, CompanionFrontendRequest>();
let consumerCount = 0;

export function registerCompanionFrontendConsumer() {
  consumerCount += 1;
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    consumerCount = Math.max(0, consumerCount - 1);
  };
}

export function companionFrontendConsumerAvailable() {
  return consumerCount > 0;
}

export function queueCompanionFrontendRequest(request: CompanionFrontendRequest) {
  queuedRequests.set(request.operationId, request);
  window.setTimeout(() => queuedRequests.delete(request.operationId), 30_000);
  window.dispatchEvent(new Event(COMPANION_FRONTEND_QUEUE_EVENT));
}

export function takeCompanionFrontendRequests() {
  const requests = [...queuedRequests.values()];
  queuedRequests.clear();
  return requests;
}
