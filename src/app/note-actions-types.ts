import type { SidebarView } from "../components/sidebar/Sidebar";
import type { NotesAction, NotesState } from "./state/app-state";
import type { NoteSaveController } from "./note-save-controller";
import type * as React from "react";

export type CreateNoteActionsDependencies = {
  dispatch: React.Dispatch<NotesAction>;
  handleEmptyNotesAfterDelete: () => void;
  noteSaveController: NoteSaveController;
  pruneDeletedNoteTabs: (removedIds: Set<string>) => void;
  setActiveView: React.Dispatch<React.SetStateAction<SidebarView>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setFolderReturnTarget: React.Dispatch<
    React.SetStateAction<{ noteId: string; label: string } | undefined>
  >;
  setOriginAllNotes: React.Dispatch<React.SetStateAction<boolean>>;
  setOriginFolderId: React.Dispatch<React.SetStateAction<string | undefined>>;
  state: NotesState;
};
