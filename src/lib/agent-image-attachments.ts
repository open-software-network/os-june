export type ImportedAgentFile = {
  path: string;
  name: string;
  previewDataUrl?: string | null;
};

export type AgentAttachmentState = {
  localId: string;
  sessionId?: string;
  kind: "image" | "file";
  displayName: string;
  workspacePath?: string;
  status: "pending" | "imported" | "attached" | "failed";
  error?: string;
};

const ATTACHABLE_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/tiff",
]);
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|tiff?)$/i;
let localIdSequence = 0;

export function parseImageDataUrl(
  dataUrl: string | null | undefined,
): { mimeType: string; dataBase64: string } | null {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl.trim());
  if (!match) return null;
  const mimeType = match[1].trim().toLowerCase();
  const dataBase64 = match[2];
  return dataBase64 && ATTACHABLE_IMAGE_MIME.has(mimeType) ? { mimeType, dataBase64 } : null;
}

export function attachmentStateFrom(
  file: ImportedAgentFile,
  sessionId?: string,
): AgentAttachmentState {
  localIdSequence += 1;
  return {
    localId: `attachment:${Date.now()}:${localIdSequence}`,
    sessionId,
    kind:
      parseImageDataUrl(file.previewDataUrl) || IMAGE_EXTENSION.test(file.name) ? "image" : "file",
    displayName: file.name,
    workspacePath: file.path,
    status: "imported",
  };
}
