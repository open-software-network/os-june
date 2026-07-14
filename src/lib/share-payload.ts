/**
 * Canonical share payloads (JUN-308). Everything inside the ciphertext,
 * type-tagged and version-prefixed. Titles live here, not in server metadata.
 * Sharing captures a snapshot at share time; there is no re-encrypt flow in
 * the MVP.
 */

export type SharePayloadMessage = {
  role: "user" | "assistant";
  content: string;
};

export function buildNotePayload({
  title,
  markdown,
  sharedAt,
}: {
  title: string;
  markdown: string;
  /** Injectable for tests; defaults to now. */
  sharedAt?: string;
}): string {
  return JSON.stringify({
    v: 1,
    kind: "note",
    title,
    markdown,
    shared_at: sharedAt ?? new Date().toISOString(),
  });
}

export function buildSessionPayload({
  title,
  messages,
  sharedAt,
}: {
  title: string;
  messages: SharePayloadMessage[];
  /** Injectable for tests; defaults to now. */
  sharedAt?: string;
}): string {
  return JSON.stringify({
    v: 1,
    kind: "session",
    title,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    shared_at: sharedAt ?? new Date().toISOString(),
  });
}
