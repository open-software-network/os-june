import { hermesBridgeImageDataUrl } from "../../lib/tauri";
import { HermesGatewayClient } from "../../lib/hermes-gateway";
import {
  createHermesMethods,
  hermesModeFor,
  isHermesFeatureSupported,
} from "../../lib/hermes-control-plane";
import {
  attachImageToSession,
  pendingImageAttachments,
  type HermesAttachmentState,
} from "../../lib/hermes-image-attach";
import { hermesArtifactStore } from "../../lib/hermes-artifact-store";
import { hermesTraceBuffer } from "../../lib/hermes-trace-buffer";
import type { AgentAttachment } from "./agent-workspace-models";
import {
  AttachBlockedError,
  markStoredImageSlashTurnsAttached,
} from "./composer/media-slash-persistence";
import type { createPendingImageActionsDependencies } from "./pending-image-actions-types";

export function createPendingImageActions(dependencies: createPendingImageActionsDependencies) {
  const { pendingFastPathImagesRef, setComposerAttachments } = dependencies;

  async function attachPendingImages(
    gateway: HermesGatewayClient,
    runtimeSessionId: string,
    storedSessionId: string,
    turnAttachments: AgentAttachment[],
  ) {
    const pending = pendingImageAttachments(turnAttachments.map((attachment) => attachment.attach));
    if (!pending.length) return turnAttachments;
    const methods = createHermesMethods(gateway);
    const heldImageDataByPath = new Map(
      turnAttachments.flatMap((attachment) =>
        attachment.attachDataUrl && attachment.attach.workspacePath
          ? [[attachment.attach.workspacePath, attachment.attachDataUrl] as const]
          : [],
      ),
    );
    const deps = {
      attachImage: methods.attachImage,
      readImageData: async (path: string) =>
        heldImageDataByPath.get(path) ?? (await hermesBridgeImageDataUrl(path)),
      isSupported: () => isHermesFeatureSupported("image.attach_bytes"),
    };
    const mode = hermesModeFor(storedSessionId);
    const failures: string[] = [];
    // The submit() flow has already cleared the composer chips by the time this
    // runs; track the per-attachment status here so a blocking failure can
    // restore the chips WITH their failed status (not the stale imported one).
    const nextStates = new Map<string, HermesAttachmentState>();
    for (const attachment of pending) {
      const result = await attachImageToSession(attachment, runtimeSessionId, deps);
      // The RPC keys off the runtime (live process) session id, but the chip
      // state, artifact timeline, and trace all key off the STORED session id —
      // the identity the rest of the UI uses (event handler, drawer, trace
      // panel). Re-stamp the result's session id to the stored one.
      const state: HermesAttachmentState = {
        ...result.state,
        sessionId: storedSessionId,
      };
      nextStates.set(attachment.localId, state);
      // Reflect the new status on the matching chip if it is still mounted
      // (matched by localId, stable across the submit). Refs/ids only, no bytes.
      setComposerAttachments((current) =>
        current.map((item) =>
          item.attach.localId === attachment.localId ? { ...item, attach: state } : item,
        ),
      );
      if (result.artifact) {
        hermesArtifactStore.recordArtifact(
          { ...result.artifact, sessionId: storedSessionId },
          mode,
        );
      }
      if (result.trace) {
        hermesTraceBuffer.recordOutbound({
          ...result.trace,
          sessionId: storedSessionId,
        });
      }
      // A gated-off runtime returns an error notice but leaves status
      // `imported` (the path-in-prompt fallback still carries the image) — that
      // is not a blocking failure.
      if (result.state.status === "failed" && result.error) {
        failures.push(result.error);
      }
    }
    if (failures.length) {
      // Carry the failed-status chips so submit()'s catch restores them with
      // the failure visible and the user can retry or remove them.
      throw new AttachBlockedError(
        failures[0],
        turnAttachments.map((item) => {
          const next = nextStates.get(item.attach.localId);
          return next ? { ...item, attach: next } : item;
        }),
      );
    }
    return turnAttachments.map((item) => {
      const next = nextStates.get(item.attach.localId);
      return next ? { ...item, attach: next } : item;
    });
  }

  function clearHeldFastPathImages(sessionId: string, heldImages: AgentAttachment[]) {
    if (!heldImages.length) return;
    const heldIds = new Set(heldImages.map((attachment) => attachment.id));
    const heldPaths = heldImages
      .map((attachment) => attachment.attach.workspacePath)
      .filter((path): path is string => Boolean(path));
    const remaining = (pendingFastPathImagesRef.current[sessionId] ?? []).filter(
      (attachment) => !heldIds.has(attachment.id),
    );
    const next = { ...pendingFastPathImagesRef.current };
    if (remaining.length) {
      next[sessionId] = remaining;
    } else {
      delete next[sessionId];
    }
    pendingFastPathImagesRef.current = next;
    markStoredImageSlashTurnsAttached(sessionId, heldPaths);
  }

  return {
    attachPendingImages,
    clearHeldFastPathImages,
  };
}
