import type * as React from "react";
import type { NoteListItemDto } from "../lib/tauri";
import type { NoteSaveController } from "./note-save-controller";
import type { NotesAction } from "./state/app-state";

export type UseNoteProcessingEventsDependencies = {
  dispatch: React.Dispatch<NotesAction>;
  noteSaveController: NoteSaveController;
  notes: NoteListItemDto[];
  setError: React.Dispatch<React.SetStateAction<string | null>>;
};
