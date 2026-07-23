import { type SidebarView } from "../components/sidebar/Sidebar";
import type { NoteDto, RecordingStatusDto } from "../lib/tauri";
import type { NotesAction } from "./state/app-state";
import type * as React from "react";

export type UseAppBootstrapDependencies = {
  appBlocked: boolean;
  calendarContextNoteProfilesRef: React.MutableRefObject<Map<string, string>>;
  calendarContextNoteUpdatesRef: React.MutableRefObject<Map<string, NoteDto>>;
  dispatch: React.Dispatch<NotesAction>;
  pendingCalendarContextAdoptionsRef: React.MutableRefObject<Set<string>>;
  recordingStatusRef: React.MutableRefObject<RecordingStatusDto | undefined>;
  setActiveView: React.Dispatch<React.SetStateAction<SidebarView>>;
  setBootstrapped: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setRecordingNote: (noteId: string | undefined) => void;
};
