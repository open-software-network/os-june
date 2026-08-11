import { discardStagedAgentAttachments, stageAgentAttachmentBytes } from "./tauri";

export const MAX_AGENT_COMPOSER_ATTACHMENTS = 8;
export const MAX_AGENT_ATTACHMENT_BYTES = 50 * 1024 * 1024;

function readDroppedFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the dropped file."));
    reader.onabort = () => reject(new Error("Could not read the dropped file."));
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error("Could not read the dropped file."));
        return;
      }
      resolve(new Uint8Array(reader.result));
    };
    reader.readAsArrayBuffer(file);
  });
}

/** Stages Finder drops one at a time so only one file's bytes are resident at once. */
export async function stageDroppedAgentFiles(
  files: File[],
  existingAttachmentCount: number,
): Promise<string[]> {
  if (!files.length) {
    throw new Error("Drop files from Finder to attach them to Clovy.");
  }
  if (existingAttachmentCount + files.length > MAX_AGENT_COMPOSER_ATTACHMENTS) {
    throw new Error(`You can attach up to ${MAX_AGENT_COMPOSER_ATTACHMENTS} files at a time.`);
  }

  const stagedPaths: string[] = [];
  try {
    for (const file of files) {
      if (file.size > MAX_AGENT_ATTACHMENT_BYTES) {
        throw new Error("Dropped files must be 50 MB or smaller.");
      }
      const bytes = await readDroppedFileBytes(file).catch(() => {
        const name = file.name || "this item";
        throw new Error(`Could not read "${name}". Folders can't be attached.`);
      });
      stagedPaths.push(await stageAgentAttachmentBytes(file.name, bytes));
    }
    return stagedPaths;
  } catch (error) {
    void discardStagedAgentAttachments(stagedPaths).catch(() => undefined);
    throw error;
  }
}
