import type {
  BootstrapResponse,
  FolderDto,
  NoteDto,
  NoteListItemDto,
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
  | { type: "recordingStatusChanged"; status: RecordingStatusDto }
  | { type: "recordingStatusCleared" }
  | { type: "folderCreated"; folder: FolderDto }
  | { type: "folderRenamed"; folder: FolderDto }
  | { type: "folderDeleted"; folderId: string }
  | { type: "folderSelected"; folderId?: string }
  | { type: "foldersLoaded"; folders: FolderDto[] }
  | { type: "notesLoaded"; notes: NoteListItemDto[] }
  | { type: "recoveriesUpdated"; recoveries: RecoverableRecordingDto[] };

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
    case "noteUpdated":
      return {
        ...upsertNote(state, action.note),
        selectedNote:
          state.selectedNoteId === action.note.id
            ? action.note
            : state.selectedNote,
      };
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
    default:
      return state;
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
