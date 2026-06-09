import type {
  BootstrapResponse,
  FolderDto,
  NoteDto,
  NoteListItemDto,
  ProcessingStatus,
  RecoverableRecordingDto,
  RecordingStatusDto,
} from "../../lib/tauri";

export type NotesState = {
  folders: FolderDto[];
  notes: NoteListItemDto[];
  selectedNoteId?: string;
  selectedNote?: NoteDto;
  selectedFolderId?: string;
  recordingStatus?: RecordingStatusDto;
  providerConfigured: boolean;
  activeRecoveries: RecoverableRecordingDto[];
};

export type NotesAction =
  | { type: "bootstrapLoaded"; payload: BootstrapResponse }
  | { type: "noteLoaded"; note: NoteDto }
  | { type: "noteUpdated"; note: NoteDto }
  | { type: "noteProcessingUpdated"; note: NoteDto }
  | { type: "recordingStatusChanged"; status: RecordingStatusDto }
  | { type: "recordingStatusCleared" }
  | { type: "recordingSessionLost"; sessionId: string }
  | { type: "folderCreated"; folder: FolderDto }
  | { type: "folderRenamed"; folder: FolderDto }
  | { type: "folderDeleted"; folderId: string }
  | { type: "folderSelected"; folderId?: string }
  | { type: "foldersLoaded"; folders: FolderDto[] }
  | { type: "notesLoaded"; notes: NoteListItemDto[] }
  | { type: "recoveriesUpdated"; recoveries: RecoverableRecordingDto[] }
  | { type: "recoveryRemoved"; sessionId: string };

export function createInitialState(): NotesState {
  return {
    folders: [],
    notes: [],
    activeRecoveries: [],
    providerConfigured: false,
  };
}

export function notesReducer(
  state: NotesState,
  action: NotesAction,
): NotesState {
  switch (action.type) {
    case "bootstrapLoaded": {
      const selectedNoteId =
        state.selectedNoteId ?? action.payload.notes[0]?.id;
      return {
        ...state,
        folders: sortFolders(action.payload.folders),
        notes: action.payload.notes,
        activeRecoveries: action.payload.activeRecoveries,
        selectedNoteId,
        providerConfigured: action.payload.providerConfigured,
      };
    }
    case "noteLoaded":
      return {
        ...upsertNote(state, action.note),
        selectedNoteId: action.note.id,
        selectedNote: action.note,
      };
    // Incidental updates (autosave, folder moves, polls): the snapshot may
    // carry stale DB state, so the processing status is merged to never
    // regress an in-flight pipeline or reopen a terminal one.
    case "noteUpdated":
      return applyNoteUpdate(state, mergeNoteUpdate(state, action.note));
    // Authoritative results of commands whose purpose is to change the
    // processing status (retry, recover, finish recording). Applied as-is so
    // they can restart processing on a note that already sits in a terminal
    // status — failed → transcribing on retry, ready → transcribing when
    // stacking another take — which the merge would otherwise swallow,
    // leaving the note stuck stale with no shimmer and no polling.
    case "noteProcessingUpdated":
      return applyNoteUpdate(state, action.note);
    case "recordingStatusChanged":
      return {
        ...state,
        recordingStatus: action.status,
      };
    case "recordingStatusCleared":
      return {
        ...state,
        recordingStatus: undefined,
      };
    // The backend no longer knows this session (e.g. it was finalized or the
    // capture process restarted). Only clear if the UI still shows that exact
    // session so a fresh recording started in the meantime is untouched.
    case "recordingSessionLost":
      return state.recordingStatus?.sessionId === action.sessionId
        ? { ...state, recordingStatus: undefined }
        : state;
    case "folderCreated":
      return {
        ...state,
        folders: sortFolders([...state.folders, action.folder]),
      };
    case "folderRenamed":
      return {
        ...state,
        folders: sortFolders(
          state.folders.map((folder) =>
            folder.id === action.folder.id ? action.folder : folder,
          ),
        ),
      };
    case "folderDeleted":
      return {
        ...state,
        folders: state.folders.filter(
          (folder) => folder.id !== action.folderId,
        ),
        selectedFolderId:
          state.selectedFolderId === action.folderId
            ? undefined
            : state.selectedFolderId,
        notes: state.notes.map((note) =>
          note.folderIds.includes(action.folderId)
            ? {
                ...note,
                folderIds: note.folderIds.filter(
                  (id) => id !== action.folderId,
                ),
              }
            : note,
        ),
      };
    case "foldersLoaded":
      return {
        ...state,
        folders: sortFolders(action.folders),
      };
    case "folderSelected":
      return {
        ...state,
        selectedFolderId: action.folderId,
        selectedNoteId: undefined,
        selectedNote: undefined,
      };
    case "notesLoaded":
      return {
        ...state,
        notes: action.notes,
        selectedNoteId: action.notes[0]?.id,
        selectedNote: undefined,
      };
    case "recoveriesUpdated":
      return {
        ...state,
        activeRecoveries: action.recoveries,
      };
    case "recoveryRemoved":
      return {
        ...state,
        activeRecoveries: state.activeRecoveries.filter(
          (recovery) => recovery.sessionId !== action.sessionId,
        ),
      };
    default:
      return state;
  }
}

function applyNoteUpdate(state: NotesState, note: NoteDto): NotesState {
  return {
    ...upsertNote(state, note),
    selectedNote: state.selectedNoteId === note.id ? note : state.selectedNote,
  };
}

function mergeNoteUpdate(state: NotesState, note: NoteDto): NoteDto {
  const current =
    state.selectedNote?.id === note.id
      ? state.selectedNote
      : state.notes.find((item) => item.id === note.id);
  if (!current) return note;

  const processingStatus = mergeProcessingStatus(
    current.processingStatus,
    note.processingStatus,
  );
  if (processingStatus === note.processingStatus) return note;

  return {
    ...note,
    processingStatus,
  };
}

function mergeProcessingStatus(
  current: ProcessingStatus,
  incoming: ProcessingStatus,
): ProcessingStatus {
  if (isTerminalProcessingStatus(incoming)) {
    return incoming;
  }
  if (isTerminalProcessingStatus(current)) return current;

  const currentRank = activeProcessingRank(current);
  const incomingRank = activeProcessingRank(incoming);
  if (
    currentRank >= activeProcessingRank("transcribing") &&
    incomingRank >= 0 &&
    incomingRank < currentRank
  ) {
    return current;
  }

  return incoming;
}

function isTerminalProcessingStatus(status: ProcessingStatus): boolean {
  return status === "ready" || status === "failed" || status === "recoverable";
}

function activeProcessingRank(status: ProcessingStatus): number {
  switch (status) {
    case "draft":
      return 0;
    case "recording":
      return 1;
    case "validating":
      return 2;
    case "transcribing":
      return 3;
    case "generating":
      return 4;
    default:
      return -1;
  }
}

function upsertNote(state: NotesState, note: NoteDto): NotesState {
  const existing = state.notes.filter((item) => item.id !== note.id);
  return {
    ...state,
    notes: [toListItem(note), ...existing].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ),
  };
}

function sortFolders(folders: FolderDto[]): FolderDto[] {
  return [...folders].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

function toListItem(note: NoteDto): NoteListItemDto {
  return {
    id: note.id,
    title: note.title,
    preview: note.preview,
    processingStatus: note.processingStatus,
    folderIds: note.folderIds,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    durationMs: note.durationMs,
  };
}
