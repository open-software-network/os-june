import type { HermesSessionInfo, NoteListItemDto } from "../../lib/tauri";

export type FolderItemIndex = {
  notesByFolderId: ReadonlyMap<string, readonly NoteListItemDto[]>;
  sessionsByFolderId: ReadonlyMap<string, readonly HermesSessionInfo[]>;
};

export function buildFolderItemIndex(
  notes: readonly NoteListItemDto[],
  sessions: readonly HermesSessionInfo[],
  sessionFolderIds: Readonly<Record<string, string[]>>,
): FolderItemIndex {
  const notesByFolderId = new Map<string, NoteListItemDto[]>();
  const sessionsByFolderId = new Map<string, HermesSessionInfo[]>();

  for (const note of notes) {
    for (const folderId of new Set(note.folderIds)) {
      appendFolderItem(notesByFolderId, folderId, note);
    }
  }

  for (const session of sessions) {
    for (const folderId of new Set(sessionFolderIds[session.id] ?? [])) {
      appendFolderItem(sessionsByFolderId, folderId, session);
    }
  }

  return { notesByFolderId, sessionsByFolderId };
}

function appendFolderItem<T>(itemsByFolderId: Map<string, T[]>, folderId: string, item: T) {
  const items = itemsByFolderId.get(folderId);
  if (items) {
    items.push(item);
  } else {
    itemsByFolderId.set(folderId, [item]);
  }
}
