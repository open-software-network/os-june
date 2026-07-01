/**
 * Orchestration for generating an image from chat and handing it to June's
 * EXISTING inline image display path.
 *
 * June already imports a pasted/dropped image into the Hermes workspace
 * (`import_hermes_bridge_file_bytes`) and shows it inline as a composer
 * attachment (`attachmentStateFrom` -> `attachImageToSession`, rendered from
 * `previewDataUrl`). This module reuses that path verbatim for a GENERATED
 * image: it calls the June API image endpoint, decodes the base64 result,
 * imports the bytes into the workspace, and returns the same
 * `HermesAttachmentState` a pasted image produces. The caller drops the
 * attachment into the composer list exactly as it does for a paste.
 *
 * UI- and gateway-free (mirrors `hermes-image-attach.ts`): side effects are
 * injected, so the flow is unit-testable and only this seam moves if the wire
 * shape changes. It never throws.
 */

import {
  attachmentStateFrom,
  parseImageDataUrl,
  type HermesAttachmentState,
} from "./hermes-image-attach";
import { messageFromError } from "./errors";
import type { GeneratedImageDto, ImportedHermesFile } from "./tauri";

export type GenerateChatImageDeps = {
  /** Calls the June API image endpoint; `model` falls back server-side. */
  generate: (prompt: string, model?: string) => Promise<GeneratedImageDto>;
  /** Imports raw bytes into the Hermes workspace (the paste path's importer). */
  importImageBytes: (name: string, bytes: Uint8Array) => Promise<ImportedHermesFile>;
  /** Resolves the default image model when the caller passes none. */
  defaultModel?: () => string;
};

export type GenerateChatImageResult =
  | {
      status: "ok";
      file: ImportedHermesFile;
      /** Ready to drop into the composer attachment list, like a pasted image. */
      attachment: HermesAttachmentState;
      /** `data:<mime>;base64,<data>` for any direct inline preview. */
      dataUrl: string;
    }
  | { status: "error"; message: string };

/** File extension for the workspace import, by mime. Defaults to png (what the
 * backend always requests from Venice). */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Wrap a generated image in a data URL — the shape the existing display path
 * (and {@link parseImageDataUrl}) understands. */
export function generatedImageDataUrl(image: { mimeType: string; imageBase64: string }): string {
  return `data:${image.mimeType};base64,${image.imageBase64}`;
}

/** Decode a base64 string to bytes for the workspace importer. */
export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function generatedImageFileName(mimeType: string): string {
  const extension = EXTENSION_BY_MIME[mimeType.trim().toLowerCase()] ?? "png";
  // Timestamped so two generations in the same session don't collide on import.
  return `generated-image-${Date.now()}.${extension}`;
}

/**
 * Generate an image from `prompt` and return it as a composer attachment that
 * renders through June's existing inline image path. Never throws: validation
 * and provider/import failures come back as `{ status: "error", message }`.
 */
export async function generateChatImage(
  prompt: string,
  deps: GenerateChatImageDeps,
  model?: string,
): Promise<GenerateChatImageResult> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return { status: "error", message: "Enter a prompt to generate an image." };
  }

  let image: GeneratedImageDto;
  try {
    image = await deps.generate(trimmed, model ?? deps.defaultModel?.());
  } catch (error) {
    return { status: "error", message: messageFromError(error) };
  }

  const dataUrl = generatedImageDataUrl(image);
  // Validate through the SAME guard the paste/attach path uses, so a malformed
  // or non-image response never reaches the display surface.
  if (!parseImageDataUrl(dataUrl)) {
    return {
      status: "error",
      message: "June returned an image it can't display.",
    };
  }

  let file: ImportedHermesFile;
  try {
    file = await deps.importImageBytes(
      generatedImageFileName(image.mimeType),
      decodeBase64(image.imageBase64),
    );
  } catch (error) {
    return { status: "error", message: messageFromError(error) };
  }

  // Same composer attachment shape a pasted/dropped image produces, so the
  // generated image renders inline through the existing display path.
  return { status: "ok", file, attachment: attachmentStateFrom(file), dataUrl };
}
