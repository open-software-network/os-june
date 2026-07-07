import { IconBubble3 } from "central-icons/IconBubble3";
import { IconChainLink1 } from "central-icons/IconChainLink1";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useEffect, useRef, useState } from "react";

import { noteReferenceToken } from "../agent/composer/noteReference";

/** The note's top-bar actions: Ask June (toggles the contextual chat panel),
 * copy-reference, and an overflow menu (delete). Lives in the note toolbar's
 * actions slot so it sits in a consistent, predictable spot across every note. */
export function NoteHeaderActions({
  noteId,
  noteTitle,
  askJuneOpen,
  askJuneWorking,
  onAskJune,
  onDelete,
}: {
  noteId: string;
  noteTitle: string;
  /** The panel is open, so the button reads as its pressed toggle. */
  askJuneOpen?: boolean;
  /** This note's chat is generating a reply — show a working dot even while
   * the panel is closed, so a fired-off question is visibly still running. */
  askJuneWorking?: boolean;
  onAskJune?: () => void;
  /** Opens the delete-note confirmation. Omitted → no overflow menu. */
  onDelete?: () => void;
}) {
  return (
    <div className="note-header-actions">
      <button
        type="button"
        className="note-header-ask"
        aria-expanded={askJuneOpen || undefined}
        data-working={askJuneWorking || undefined}
        title={askJuneWorking ? "June is working on your question" : undefined}
        onClick={() => onAskJune?.()}
      >
        <IconBubble3 size={14} aria-hidden />
        Ask June
        {askJuneWorking ? <span className="note-header-ask-dot" aria-hidden /> : null}
      </button>
      <CopyNoteReferenceButton noteId={noteId} title={noteTitle} />
      {onDelete ? <NoteOverflowMenu onDelete={onDelete} /> : null}
    </div>
  );
}

function NoteOverflowMenu({ onDelete }: { onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="note-actions-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="icon-button note-actions-menu-trigger"
        aria-label="Note actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconDotGrid1x3Horizontal size={16} />
      </button>
      {open ? (
        <div className="sidebar-identity-menu note-actions-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="destructive"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            <IconTrashCan size={14} />
            Delete note
          </button>
        </div>
      ) : null}
    </div>
  );
}

function CopyNoteReferenceButton({ noteId, title }: { noteId: string; title: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(noteReferenceToken({ id: noteId, title }));
      setCopied(true);
    } catch {
      // Clipboard API can fail in restricted contexts; stay silent
      // rather than nag, since the user can retry.
    }
  }

  return (
    <button
      type="button"
      className="note-reference-copy"
      onClick={() => void handleCopy()}
      data-copied={copied || undefined}
      aria-label="Copy note reference"
      title={copied ? "Copied" : "Copy note reference"}
    >
      {copied ? <IconCheckmark2Small size={14} /> : <IconChainLink1 size={14} />}
    </button>
  );
}
