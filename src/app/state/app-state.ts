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
  | { type: "noteDeleted"; noteId: string }
  | { type: "recordingStatusChanged"; status: RecordingStatusDto }
  | { type: "recordingStatusCleared" }
  | { type: "folderCreated"; folder: FolderDto }
  | { type: "folderDeleted"; folderId: string; deleteNotes: boolean }
  | { type: "folderSelected"; folderId?: string }
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
        folders: action.payload.folders,
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
      return reconcileUpdatedNote(state, action.note);
    case "noteDeleted": {
      const isSelected = state.selectedNoteId === action.noteId;
      return {
        ...state,
        notes: state.notes.filter((note) => note.id !== action.noteId),
        selectedNoteId: isSelected ? undefined : state.selectedNoteId,
        selectedNote: isSelected ? undefined : state.selectedNote,
      };
    }
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
        folders: [...state.folders, action.folder].sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
        ),
        selectedFolderId: action.folder.id,
      };
    case "folderDeleted":
      return reconcileDeletedFolder(state, action.folderId, action.deleteNotes);
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

function reconcileDeletedFolder(
  state: NotesState,
  folderId: string,
  deleteNotes: boolean,
): NotesState {
  const selectedNoteWasDeleted =
    deleteNotes && state.selectedNote?.folderIds.includes(folderId);
  return {
    ...state,
    folders: state.folders.filter((folder) => folder.id !== folderId),
    notes: state.notes
      .filter((note) => !deleteNotes || !note.folderIds.includes(folderId))
      .map((note) => ({
        ...note,
        folderIds: note.folderIds.filter((id) => id !== folderId),
      })),
    selectedFolderId:
      state.selectedFolderId === folderId ? undefined : state.selectedFolderId,
    selectedNoteId: selectedNoteWasDeleted ? undefined : state.selectedNoteId,
    selectedNote: selectedNoteWasDeleted
      ? undefined
      : state.selectedNote
        ? {
            ...state.selectedNote,
            folderIds: state.selectedNote.folderIds.filter(
              (id) => id !== folderId,
            ),
          }
        : undefined,
  };
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

function reconcileUpdatedNote(state: NotesState, note: NoteDto): NotesState {
  const isSelected = state.selectedNoteId === note.id;
  if (
    state.selectedFolderId &&
    !note.folderIds.includes(state.selectedFolderId)
  ) {
    return {
      ...state,
      notes: state.notes.filter((item) => item.id !== note.id),
      selectedNoteId: isSelected ? undefined : state.selectedNoteId,
      selectedNote: isSelected ? undefined : state.selectedNote,
    };
  }

  return {
    ...upsertNote(state, note),
    selectedNote: isSelected ? note : state.selectedNote,
  };
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
