import type { NoteDto } from "../lib/tauri";
import type * as React from "react";
import type { NotesAction } from "./state/app-state";

export type UseProcessingStatusPollDependencies = {
  dispatch: React.Dispatch<NotesAction>;
  selectedNote: NoteDto | undefined;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
};
