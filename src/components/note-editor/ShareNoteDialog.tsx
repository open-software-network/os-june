import { useEffect, useState } from "react";
import type { NoteDto } from "../../lib/tauri";
import { revokeNoteShare, shareNote } from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";

type Props = {
  note: NoteDto;
  open: boolean;
  onClose: () => void;
  /** Display name the share page attributes the note to. */
  sharedBy: string;
  /** Receives the refreshed note after a share or revoke succeeds. */
  onNoteShared: (note: NoteDto) => void;
};

/**
 * Publishing a note is the one deliberate exception to "your notes never
 * leave your Mac", so the dialog says exactly what will happen before the
 * user does it: what gets uploaded, who can read it, and that it can be
 * revoked. After sharing it becomes the link manager (copy, refresh
 * the snapshot, stop sharing).
 */
export function ShareNoteDialog({
  note,
  open,
  onClose,
  sharedBy,
  onNoteShared,
}: Props) {
  const [busy, setBusy] = useState<"share" | "revoke">();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setError(undefined);
      setCopied(false);
      setBusy(undefined);
    }
  }, [open]);

  const shared = Boolean(note.shareUrl);

  async function handleShare() {
    setError(undefined);
    setBusy("share");
    try {
      const updated = await shareNote({ noteId: note.id, sharedBy });
      onNoteShared(updated);
      if (updated.shareUrl) {
        try {
          await navigator.clipboard.writeText(updated.shareUrl);
          setCopied(true);
        } catch {
          // Clipboard can fail in restricted contexts; the URL stays visible.
        }
      }
    } catch (shareError) {
      setError(messageFromError(shareError));
    } finally {
      setBusy(undefined);
    }
  }

  async function handleCopy() {
    if (!note.shareUrl) return;
    try {
      await navigator.clipboard.writeText(note.shareUrl);
      setCopied(true);
    } catch {
      // Clipboard can fail in restricted contexts; stay silent.
    }
  }

  async function handleRevoke() {
    setError(undefined);
    setBusy("revoke");
    try {
      const updated = await revokeNoteShare(note.id);
      onNoteShared(updated);
      setCopied(false);
    } catch (revokeError) {
      setError(messageFromError(revokeError));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={shared ? "This note is shared" : "Share this note"}
      width={460}
      footer={
        shared ? (
          <>
            <button
              type="button"
              className="primary-action"
              disabled={busy !== undefined}
              onClick={() => void handleRevoke()}
            >
              {busy === "revoke" ? "Stopping…" : "Stop sharing"}
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={busy !== undefined}
              onClick={() => void handleCopy()}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="primary-action" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={busy !== undefined}
              onClick={() => void handleShare()}
            >
              {busy === "share" ? "Creating link…" : "Create link"}
            </button>
          </>
        )
      }
    >
      {shared ? (
        <div className="share-note-body">
          <input
            className="share-note-url"
            readOnly
            value={note.shareUrl ?? ""}
            aria-label="Share link"
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className="share-note-hint">
            Anyone with this link can read the note. It shows the note as you
            last shared it:{" "}
            <button
              type="button"
              className="share-note-link"
              disabled={busy !== undefined}
              onClick={() => void handleShare()}
            >
              update the link
            </button>{" "}
            to publish your latest edits.
          </p>
        </div>
      ) : (
        <div className="share-note-body">
          <p>
            This uploads the note's title and text to June's server and
            creates a read-only web page anyone with the link can open, no
            account needed. Nothing else leaves your Mac: not the audio, not
            the transcript, not your other notes.
          </p>
          <p className="share-note-hint">
            You can stop sharing at any time, and the page goes dark
            immediately.
          </p>
        </div>
      )}
      {error ? <p className="share-note-error">{error}</p> : null}
    </Dialog>
  );
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
