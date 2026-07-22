import type * as React from "react";
import type { NotesAction, NotesState } from "./state/app-state";

export type UseRecordingStatusPollDependencies = {
  dispatch: React.Dispatch<NotesAction>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  state: NotesState;
};
