import { IconBubble3 } from "central-icons/IconBubble3";
import { IconArrowShareRight } from "central-icons/IconArrowShareRight";
import { IconAudio } from "central-icons/IconAudio";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconFilePdf } from "central-icons/IconFilePdf";
import { IconReference } from "central-icons/IconReference";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useEffect, useRef, useState } from "react";

import { noteReferenceToken } from "../agent/composer/noteReference";
import { toast } from "../ui/Toaster";

/** The note's top-bar actions: Ask June (toggles the contextual chat panel),
 * share, and an overflow menu (copy reference, export, delete). Lives in the
 * note toolbar's actions slot so it sits in a consistent, predictable spot
 * across every note. */
export function NoteHeaderActions({
  noteId,
  noteTitle,
  askJuneOpen,
  askJuneWorking,
  onAskJune,
  onShare,
  onExportPdf,
  onDownloadAudio,
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
  /** Opens the private-sharing dialog for this note. */
  onShare?: () => void;
  /** Opens the system print sheet with a PDF-ready version of the note. */
  onExportPdf?: () => void;
  /** Downloads the note's finalized audio artifacts. */
  onDownloadAudio?: () => void;
  /** Opens the delete-note confirmation. */
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
      {onShare ? (
        <button
          type="button"
          className="icon-button note-header-share"
          aria-label="Share note"
          title="Share"
          onClick={onShare}
        >
          <IconArrowShareRight size={16} />
        </button>
      ) : null}
      <NoteOverflowMenu
        noteId={noteId}
        noteTitle={noteTitle}
        onExportPdf={onExportPdf}
        onDownloadAudio={onDownloadAudio}
        onDelete={onDelete}
      />
    </div>
  );
}

function NoteOverflowMenu({
  noteId,
  noteTitle,
  onExportPdf,
  onDownloadAudio,
  onDelete,
}: {
  noteId: string;
  noteTitle: string;
  onExportPdf?: () => void;
  onDownloadAudio?: () => void;
  onDelete?: () => void;
}) {
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

  async function handleCopyReference() {
    try {
      await navigator.clipboard.writeText(noteReferenceToken({ id: noteId, title: noteTitle }));
      toast("Reference for June copied");
    } catch {
      // Clipboard API can fail in restricted contexts; stay silent so retrying
      // the same menu action remains the least disruptive recovery.
    }
  }

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
            onClick={() => {
              setOpen(false);
              void handleCopyReference();
            }}
          >
            <IconReference size={14} />
            Copy reference for June
          </button>
          {onExportPdf ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onExportPdf();
              }}
            >
              <IconFilePdf size={14} />
              Export as PDF
            </button>
          ) : null}
          {onDownloadAudio ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onDownloadAudio();
              }}
            >
              <IconAudio size={14} />
              Download audio
            </button>
          ) : null}
          {onDelete ? (
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
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
