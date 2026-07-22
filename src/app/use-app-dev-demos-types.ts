import { type SidebarView } from "../components/sidebar/Sidebar";
import { type LiveTranscriptEventDto } from "../lib/tauri";
import type { RecordingStatusDto } from "../lib/tauri";
import { type UpdateInstallProgress } from "./update-decision";
import type { NotesAction } from "./state/app-state";
import type { JuneUpdate } from "../lib/updater";
import type { UpdatePromptPayload } from "./update-decision";
import type * as React from "react";

export type UseAppDevDemosDependencies = {
  dispatch: React.Dispatch<NotesAction>;
  getSelectedNoteId: () => string | undefined;
  recordingStatusRef: React.MutableRefObject<RecordingStatusDto | undefined>;
  setActiveView: React.Dispatch<React.SetStateAction<SidebarView>>;
  setCheckingUpdate: React.Dispatch<React.SetStateAction<boolean>>;
  setLiveTranscriptEvents: React.Dispatch<React.SetStateAction<LiveTranscriptEventDto[]>>;
  setPreparingUpdate: React.Dispatch<React.SetStateAction<boolean>>;
  setRecordingNote: (noteId: string | undefined) => void;
  setRelaunchingUpdate: React.Dispatch<React.SetStateAction<boolean>>;
  setReadyUpdate: React.Dispatch<React.SetStateAction<UpdatePromptPayload<JuneUpdate> | null>>;
  setUpdateProgress: React.Dispatch<React.SetStateAction<UpdateInstallProgress | null>>;
  setUpdateStatus: (status: string | null, failed?: boolean) => void;
};
