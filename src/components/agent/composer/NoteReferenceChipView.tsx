import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { IconNoteText } from "central-icons/IconNoteText";

import { displayNoteTitle } from "./noteReference";

export function NoteReferenceChipView({ node }: NodeViewProps) {
  const title = typeof node.attrs.title === "string" ? node.attrs.title : "";
  const noteId = typeof node.attrs.noteId === "string" ? node.attrs.noteId : "";

  return (
    <NodeViewWrapper
      as="span"
      className="agent-note-reference-chip"
      data-note-id={noteId}
      contentEditable={false}
    >
      <span className="agent-note-reference-chip-icon" aria-hidden="true">
        <IconNoteText size={10} />
      </span>
      <span className="agent-note-reference-chip-title">{displayNoteTitle(title)}</span>
    </NodeViewWrapper>
  );
}
