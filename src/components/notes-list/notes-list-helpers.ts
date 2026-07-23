import type { NoteListItemDto } from "../../lib/tauri";

export function filterNotesByQuery(notes: NoteListItemDto[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return notes;

  return notes.filter((note) => `${note.title} ${note.preview}`.toLowerCase().includes(normalized));
}
