/** Persistence for the note → chat session pairing. The note chat panel keeps
 * one agent session per note so reopening the panel continues the same
 * conversation; June only remembers which session belongs to which note. */

const STORAGE_KEY = "june.noteChat.sessionsByNote.v1";

type NoteChatSessionMap = Record<string, string>;

function readMap(): NoteChatSessionMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: NoteChatSessionMap = {};
    for (const [noteId, sessionId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof sessionId === "string" && sessionId) map[noteId] = sessionId;
    }
    return map;
  } catch {
    return {};
  }
}

function writeMap(map: NoteChatSessionMap) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota/privacy failures degrade to a fresh session next open.
  }
}

export function noteChatSessionIdFor(noteId: string): string | undefined {
  return readMap()[noteId];
}

export function rememberNoteChatSession(noteId: string, sessionId: string) {
  const map = readMap();
  map[noteId] = sessionId;
  writeMap(map);
}

/** Drops the pairing when the stored session no longer exists. */
export function forgetNoteChatSession(noteId: string) {
  const map = readMap();
  if (!(noteId in map)) return;
  delete map[noteId];
  writeMap(map);
}
