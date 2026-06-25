/**
 * Pure orchestration for the structured image attach/edit flow (feature 19).
 *
 * June's existing attachment path imports a dropped/pasted/picked file into the
 * Hermes workspace (`<hermes_home>/workspace/uploads/…`, via the
 * `import_hermes_bridge_file*` bridge commands) and references its PATH in the
 * prompt text. That keeps working. This module adds the STRUCTURED path on top:
 * for image attachments it calls the typed `image.attach` control-plane method
 * (`createHermesMethods(...).attachImage`), so the model/tools receive the image
 * as a first-class input rather than only a path mentioned in prose. Explicit
 * source-image selection is what makes image EDITING reliable (the upstream
 * image_generate edit input shouldn't have to guess which path the user meant).
 *
 * It is deliberately UI- and gateway-free (mirrors `hermes-session-steer.ts`):
 * the orchestrator takes its side effects as injected functions, so it is
 * trivially unit-testable and only this seam moves if the wire shape changes.
 *
 * BASE64 DISCIPLINE: the image bytes are read on demand AT ATTACH TIME (through
 * the injected {@link AttachImageDeps.readImageData}, backed by the existing
 * `hermes_bridge_file_preview` bridge command which returns a `data:…;base64,…`
 * url for the workspace file) and discarded the moment the RPC resolves. The
 * base64 NEVER lands on {@link HermesAttachmentState} (which holds only a
 * workspace path + ids), is NEVER passed to the trace buffer (the redacted
 * {@link AttachImageResult.trace} reports only method/session/mime/byte-length),
 * and is NEVER stored in the artifact timeline. Long-term React state keeps file
 * refs and attachment ids, not raw bytes.
 */

import type { ArtifactKind } from "./hermes-artifact-store";
import type { OutboundTraceInput } from "./hermes-trace-buffer";
import type { AttachImageParams } from "./hermes-control-plane";
import type { ImportedHermesFile } from "./tauri";
import { messageFromError } from "./errors";

/**
 * The lifecycle of one composer attachment, surfaced as a status chip:
 * - `pending`: created, import not finished (transient; the importer flips it).
 * - `imported`: copied into the workspace; for a file this is terminal, for an
 *   image it is the "ready to attach" state.
 * - `attached`: the structured `image.attach` RPC acked — visible to model/tools.
 * - `failed`: import or attach errored; `error` carries the user-facing copy.
 */
export type HermesAttachmentStatus =
  | "pending"
  | "imported"
  | "attached"
  | "failed";

/**
 * UI/runtime state for one attachment. Carries file REFERENCES (a workspace
 * path, an attachment id) — never the image bytes. `localId` is stable for the
 * composer list/keying; `sessionId` is the Hermes session it is (or will be)
 * attached to; `hermesAttachmentId` is whatever the gateway returned, if any.
 */
export type HermesAttachmentState = {
  localId: string;
  sessionId?: string;
  kind: "image" | "file";
  displayName: string;
  workspacePath?: string;
  hermesAttachmentId?: string;
  status: HermesAttachmentStatus;
  error?: string;
};

/** A minimal artifact seed for feature 14's `hermesArtifactStore.record` is not
 * used here (that store ingests classified gateway events). Instead the attach
 * flow produces this seed, which AgentWorkspace records directly through the
 * store's `record(...)`-adjacent path. Shape mirrors the store's `AgentArtifact`
 * minus the fields the store fills (id/mode/createdAt). */
export type AttachedArtifactSeed = {
  sessionId: string;
  kind: ArtifactKind;
  action: "attached" | "failed";
  path?: string;
  displayName?: string;
  previewAvailable?: boolean;
};

/** What `attachImageToSession` resolves to: the next chip state, plus optional
 * side-effect payloads for the caller to apply (artifact timeline + redacted
 * trace), plus user-facing error copy when the attach did not succeed. */
export type AttachImageResult = {
  state: HermesAttachmentState;
  artifact?: AttachedArtifactSeed;
  trace?: OutboundTraceInput;
  error?: string;
};

/** Injected side effects. `attachImage` is `createHermesMethods(...).attachImage`;
 * `readImageData` reads the workspace file as a `data:…;base64,…` url (or null
 * if it can't be read as an image); `isSupported` is the feature gate
 * (`() => isHermesFeatureSupported("image.attach")`). */
export type AttachImageDeps = {
  attachImage: (params: AttachImageParams) => Promise<unknown>;
  readImageData: (path: string) => Promise<string | null>;
  isSupported: () => boolean;
};

/** The image mime types June's bridge can preview/attach (mirrors the Rust
 * `image_mime_type` allow-list). */
const ATTACHABLE_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/tiff",
]);

/** Image file extensions that map onto an attachable mime, for classifying an
 * import that arrived without a usable preview data url. */
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|tiff?)$/i;

/** Shown when the running Hermes can't do structured image attach. The image is
 * not lost: it stays imported and its path still rides along in the prompt. */
export const ATTACH_UNSUPPORTED_NOTICE =
  "This version of June can't attach images to the model directly. The image is in the workspace and its path is included in your message instead.";

/** Whether a mime type is an image June can attach via image.attach. */
export function isAttachableImageType(mimeType: string): boolean {
  return ATTACHABLE_IMAGE_MIME.has(mimeType.trim().toLowerCase());
}

/**
 * Split a `data:<mime>;base64,<data>` url into its parts, but only for an
 * attachable image mime. Returns null for non-image mimes, non-base64 urls, or
 * anything malformed/empty — so the caller never sends junk to the gateway.
 */
export function parseImageDataUrl(
  dataUrl: string | null | undefined,
): { mimeType: string; dataBase64: string } | null {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl.trim());
  if (!match) return null;
  const mimeType = match[1].trim().toLowerCase();
  const dataBase64 = match[2];
  if (!dataBase64 || !isAttachableImageType(mimeType)) return null;
  return { mimeType, dataBase64 };
}

/** Whether an imported file should take the structured image-attach path. Uses
 * the preview data url's mime when present, else falls back to the extension. */
function isImageImport(file: ImportedHermesFile): boolean {
  const fromPreview = parseImageDataUrl(file.previewDataUrl);
  if (fromPreview) return true;
  return IMAGE_EXTENSION.test(file.name);
}

let localIdSeq = 0;

/** Build the initial chip state for a freshly imported file. Images become
 * `kind:"image"` (eligible for image.attach); everything else is `kind:"file"`.
 * Status starts at `imported` (the import already completed). No bytes. */
export function attachmentStateFrom(
  file: ImportedHermesFile,
  sessionId?: string,
): HermesAttachmentState {
  localIdSeq += 1;
  return {
    localId: `attach:${Date.now()}:${localIdSeq}`,
    sessionId,
    kind: isImageImport(file) ? "image" : "file",
    displayName: file.name,
    workspacePath: file.path,
    status: "imported",
  };
}

/** The imported images still awaiting a structured attach (eligible to send to
 * image.attach before the next prompt). Skips files and already-attached/failed
 * images. */
export function pendingImageAttachments(
  states: HermesAttachmentState[],
): HermesAttachmentState[] {
  return states.filter(
    (state) => state.kind === "image" && state.status === "imported",
  );
}

/** Whether any attachment is in a failed state that should block/​warn before a
 * prompt submit (so the user doesn't send believing the image went through). */
export function attachmentBlocksSubmit(
  states: HermesAttachmentState[],
): boolean {
  return states.some((state) => state.status === "failed");
}

/** User-facing copy for an attach failure. Never leaks JSON-RPC codes or raw
 * provider noise; never uses typographic dashes. */
export function attachErrorNotice(displayName: string, err: unknown): string {
  const base = `Couldn't attach "${displayName}" to June.`;
  const detail = messageFromError(err);
  if (/unsupported|not a supported|file type/i.test(detail)) {
    return `${base} That file type can't be attached as an image.`;
  }
  return `${base} The image stayed in the workspace; try again or remove it.`;
}

/**
 * Attach one imported image to a Hermes session through the typed `image.attach`
 * method. Pure w.r.t. injected {@link AttachImageDeps}. Resolves to the next
 * chip {@link HermesAttachmentState} plus, on success, an artifact seed and a
 * REDACTED outbound trace entry; on failure, `state.status` is `failed` and
 * `error` carries recoverable copy. Never throws.
 *
 * Order of guards: feature gate → image-kind → read-bytes → RPC. A gated-off
 * runtime is NOT a failure (the image is still imported and its path rides in
 * the prompt) — it returns the unchanged `imported` state with a notice.
 */
export async function attachImageToSession(
  attachment: HermesAttachmentState,
  sessionId: string,
  deps: AttachImageDeps,
): Promise<AttachImageResult> {
  const withSession: HermesAttachmentState = { ...attachment, sessionId };

  if (!deps.isSupported()) {
    // Gated off: keep the image imported so the existing path-in-prompt
    // fallback still carries it. No artifact, no hard failure.
    return { state: withSession, error: ATTACH_UNSUPPORTED_NOTICE };
  }

  if (attachment.kind !== "image" || !attachment.workspacePath) {
    const error = attachErrorNotice(
      attachment.displayName,
      new Error("unsupported file type"),
    );
    return {
      state: { ...withSession, status: "failed", error },
      artifact: failedArtifact(withSession),
      error,
    };
  }

  let parsed: { mimeType: string; dataBase64: string } | null;
  try {
    parsed = parseImageDataUrl(
      await deps.readImageData(attachment.workspacePath),
    );
  } catch (err) {
    const error = attachErrorNotice(attachment.displayName, err);
    return {
      state: { ...withSession, status: "failed", error },
      artifact: failedArtifact(withSession),
      error,
    };
  }

  if (!parsed) {
    const error = attachErrorNotice(
      attachment.displayName,
      new Error("unsupported file type"),
    );
    return {
      state: { ...withSession, status: "failed", error },
      artifact: failedArtifact(withSession),
      error,
    };
  }

  try {
    const result = await deps.attachImage({
      sessionId,
      mimeType: parsed.mimeType,
      dataBase64: parsed.dataBase64,
    });
    return {
      state: {
        ...withSession,
        status: "attached",
        hermesAttachmentId: attachmentIdFrom(result),
      },
      artifact: {
        sessionId,
        kind: "image",
        action: "attached",
        path: attachment.workspacePath,
        displayName: attachment.displayName,
        previewAvailable: true,
      },
      // REDACTED on purpose: the trace records that an attach happened and how
      // big it was, never the base64 itself (the trace buffer would otherwise
      // stringify it into its payload preview — `data_base64` is not a
      // sanitizer-recognized secret key).
      trace: {
        sessionId,
        method: "image.attach",
        params: {
          session_id: sessionId,
          mime_type: parsed.mimeType,
          bytes: approxByteLength(parsed.dataBase64),
        },
      },
    };
  } catch (err) {
    const error = attachErrorNotice(attachment.displayName, err);
    return {
      state: { ...withSession, status: "failed", error },
      artifact: failedArtifact(withSession),
      error,
    };
  }
}

function failedArtifact(state: HermesAttachmentState): AttachedArtifactSeed {
  return {
    sessionId: state.sessionId ?? "",
    kind: "image",
    action: "failed",
    path: state.workspacePath,
    displayName: state.displayName,
    previewAvailable: false,
  };
}

/** Pull an attachment id off the gateway result if it returned one, tolerating
 * snake_case/camelCase. Undefined when the result carries none. */
function attachmentIdFrom(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  for (const key of ["attachment_id", "attachmentId", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Approximate decoded byte length of a base64 string (for the trace's size
 * hint only — the bytes themselves are never stored). */
function approxByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
