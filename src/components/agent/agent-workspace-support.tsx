import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import type { HermesAttachmentState } from "../../lib/hermes-image-attach";
import type { SkillSlashResolution } from "../../lib/skill-slash-commands";
import type { AgentTaskDto } from "../../lib/tauri";
import { FileTypeIcon } from "./FileTypeIcon";
import type { AgentAttachment } from "./agent-workspace-models";

export function isResolvedSkillSlashResolution(
  resolution: SkillSlashResolution,
): resolution is Extract<SkillSlashResolution, { status: "resolved" }> {
  return resolution.status === "resolved";
}

export function sameAgentAttachments(left: AgentAttachment[], right: AgentAttachment[]) {
  return (
    left.length === right.length &&
    left.every((attachment, index) => attachment.id === right[index]?.id)
  );
}

/** Short, sentence-case status word for an attachment chip (feature 19). Empty
 * for the resting imported/pending states — the chip already reads as "ready";
 * only the terminal attached/failed states earn a label. No dashes. */
function attachmentStatusLabel(state: HermesAttachmentState): string {
  switch (state.status) {
    case "attached":
      return "Attached";
    case "failed":
      return "Couldn't attach";
    default:
      return "";
  }
}

function attachmentFileTypeLabel(name: string): string {
  const filename = name.split(/[\\/]/).pop() ?? name;
  const extensionIndex = filename.lastIndexOf(".");
  if (extensionIndex <= 0 || extensionIndex === filename.length - 1) return "File";
  return filename.slice(extensionIndex + 1).toUpperCase();
}

export function AgentAttachmentTile({
  attachment,
  onRemove,
}: {
  attachment: AgentAttachment;
  onRemove?: () => void;
}) {
  const statusLabel = attachmentStatusLabel(attachment.attach);
  return (
    <span
      className="agent-attachment-chip"
      data-kind={attachment.previewDataUrl ? "image" : "file"}
      data-attach-status={attachment.attach.status}
      title={attachment.attach.error ?? attachment.name}
    >
      {attachment.previewDataUrl ? (
        <img src={attachment.previewDataUrl} alt="" aria-hidden="true" />
      ) : (
        <>
          <span className="agent-attachment-file-icon" aria-hidden="true">
            <FileTypeIcon name={attachment.name} size={18} />
          </span>
          <span className="agent-attachment-file-details">
            <span className="agent-attachment-name">{attachment.name}</span>
            <span className="agent-attachment-file-meta">
              <span className="agent-attachment-file-type">
                {attachmentFileTypeLabel(attachment.name)}
              </span>
              {statusLabel ? (
                <span
                  className="agent-attachment-status"
                  data-attach-status={attachment.attach.status}
                >
                  {statusLabel}
                </span>
              ) : null}
            </span>
          </span>
        </>
      )}
      {attachment.previewDataUrl ? (
        <span className="agent-attachment-name">{attachment.name}</span>
      ) : null}
      {attachment.previewDataUrl && statusLabel ? (
        <span className="agent-attachment-status" data-attach-status={attachment.attach.status}>
          {statusLabel}
        </span>
      ) : null}
      {onRemove ? (
        <button type="button" aria-label={`Remove ${attachment.name}`} onClick={onRemove}>
          {attachment.previewDataUrl ? <IconCrossMedium size={14} /> : <IconCrossSmall size={12} />}
        </button>
      ) : null}
    </span>
  );
}

export function commandTokensForResolutions(
  commandNames: string[],
  tokens: Array<{ name: string; from: number; to: number }>,
) {
  return commandNames
    .map((name) => tokens.find((token) => slashCommandKey(token.name) === slashCommandKey(name)))
    .filter((token): token is { name: string; from: number; to: number } => Boolean(token));
}

export function slashCommandKey(name: string) {
  return name.trim().toLowerCase();
}

export function ActivityIndicator({
  active,
  large = false,
  status = "running",
}: {
  active: boolean;
  large?: boolean;
  status?: "running" | "waitingForUser";
}) {
  if (!active) return null;
  return (
    <span className="agent-activity-indicator" data-large={large} data-status={status}>
      <span aria-hidden="true" />
      {status === "waitingForUser" ? "Needs you" : "Working"}
    </span>
  );
}

export function taskActivitySummary(task: AgentTaskDto) {
  switch (task.status) {
    case "queued":
      return "Starting work.";
    case "running":
      return task.progressSummary || "Working now.";
    default:
      return "";
  }
}

export function DownloadToastMessage({ action, fileName }: { action: string; fileName: string }) {
  const label = `${action} ${fileName}`;
  return (
    <span className="june-download-toast-message" aria-label={label}>
      <span className="june-download-toast-action">{action}</span>
      <span className="june-download-toast-file" title={fileName}>
        {fileName}
      </span>
    </span>
  );
}

export function ensureDownloadFileExtension(fileName: string, fallbackExtension: string) {
  const trimmed = fileName.trim();
  if (!trimmed) return `download.${fallbackExtension}`;
  if (/\.[^./\\]+$/.test(trimmed)) return trimmed;
  return `${trimmed}.${fallbackExtension}`;
}

// FileReader instead of Blob.arrayBuffer(): same everywhere a drop can land
// (WKWebView and jsdom included).
export function readFileBytes(file: File) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the dropped file."));
    reader.readAsArrayBuffer(file);
  });
}

export function omitRecordKey<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export function moveRecordKey<T>(record: Record<string, T[]>, from: string, to: string) {
  const moved = record[from] ?? [];
  const existing = record[to] ?? [];
  const next = { ...record };
  delete next[from];
  if (moved.length || existing.length) {
    next[to] = [...existing, ...moved];
  } else {
    delete next[to];
  }
  return next;
}

// Survives app restarts (localStorage, not sessionStorage): restoring an
// existing conversation after a relaunch is always safe, unlike the pending
// new-session marker, which must NOT outlive its navigation.
