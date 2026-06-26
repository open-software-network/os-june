/**
 * Bounded, GLOBAL (cross-session) store of the files an agent has touched — the
 * data source behind feature 14's "Artifacts" timeline in the Agent activity
 * drawer.
 *
 * Where feature 11's {@link import("./hermes-activity-store")} answers "what is
 * each session doing right now?", this store answers "what files has each
 * session created, changed, read, downloaded, or failed to reach?". For each
 * session it keeps a bounded, newest-first list of {@link AgentArtifact} records
 * derived from `tool` completions; the drawer renders them and routes a click to
 * the app's existing file preview/download flow.
 *
 * Fed ONLY from the normalized {@link JuneHermesEvent} stream (the classifier's
 * output), never from raw gateway frames — raw JSON belongs to feature 15's
 * trace panel. AgentWorkspace owns the single write path: it calls
 * `record(event, mode)` at the existing `classifyHermesEvent` site, exactly
 * where it already feeds the activity, pending-action, and unsupported stores.
 *
 * Deliberately a SEPARATE store from feature 11's `AgentActivityRecord` (rather
 * than a field on it): feature 12 concurrently owns the activity record's
 * subagent deepening, so keeping artifacts in their own store avoids a collision
 * on that shape. The two stores share the same shape of API (factory +
 * singleton, `subscribe`/`getVersion`, total `record`) so AgentWorkspace adapts
 * both with the same `useSyncExternalStore` pattern.
 *
 * Extraction is CONSERVATIVE on purpose (see {@link artifactsFromToolEvent}): it
 * only reads a small set of known path/url fields off a tool-complete payload.
 * It never parses arbitrary prose (a command string, an output blob) for things
 * that look like paths — a false "the agent touched /etc/passwd" is worse than a
 * missed artifact.
 *
 * REUSE NOTE (feature 19 — structured image attachment): the {@link AgentArtifact}
 * shape is intentionally generic across file/image/directory/url so an attached
 * or edited image is representable here without a new type. Feature 19 can add an
 * `"attached"` action (see {@link ArtifactAction}) and feed this store from its
 * attach/edit flow the same way; the `kind: "image"` + `previewAvailable` fields
 * already carry what a thumbnail needs.
 */

import type { HermesMode, JuneHermesEvent } from "./hermes-control-plane";
import { asRecord, nonEmpty } from "./hermes-control-plane";

/**
 * Cap on the number of artifacts kept per session. A long agent run touches many
 * files; we keep the most recent ones (eviction drops the oldest) so the drawer
 * stays bounded and fast.
 */
export const ARTIFACTS_PER_SESSION_CAP = 100;

/** Cap on the number of sessions tracked at once, mirroring the activity store. */
export const ARTIFACT_SESSIONS_CAP = 50;

/** What kind of thing the artifact points at. `unknown` is the safe fallback
 * when a path has no telling extension and isn't obviously a directory or url. */
export type ArtifactKind = "file" | "image" | "directory" | "url" | "unknown";

/**
 * What the agent did with the artifact. `failed` means the access errored (e.g.
 * a sandboxed write to an unrestricted path was denied). `attached` (feature 19)
 * means the user attached an image into the session via the structured
 * `image.attach` flow — it shows in the timeline like any other artifact.
 */
export type ArtifactAction =
  | "created"
  | "modified"
  | "read"
  | "downloaded"
  | "failed"
  | "attached";

/**
 * One file/url an agent touched. `path` is the location as Hermes reported it
 * (a filesystem path for files/dirs, the URL for `url`); the drawer pairs it
 * with `mode` to label the blast radius (sandboxed copy vs unrestricted local
 * path vs remote). `previewAvailable` is a cheap hint for the UI (image/text-ish
 * files) — the actual preview is still fetched lazily through the existing
 * bridge command. `createdAt` is epoch ms (when June recorded it).
 */
export type AgentArtifact = {
  id: string;
  sessionId: string;
  mode: HermesMode;
  kind: ArtifactKind;
  action: ArtifactAction;
  path?: string;
  displayName?: string;
  previewAvailable?: boolean;
  createdAt: number;
  sourceToolCallId?: string;
};

/**
 * A directly-recorded artifact that does NOT originate from a classified
 * gateway tool event. Feature 19's image attach flow produces one of these and
 * feeds it through {@link HermesArtifactStore.recordArtifact} so an attached (or
 * failed-to-attach) image lands in the same timeline as the agent's own file
 * touches. `id`, `mode`, and `createdAt` are filled in by the store, exactly as
 * for the event-derived path; the input carries no image bytes.
 */
export type DirectArtifactInput = {
  sessionId: string;
  kind: ArtifactKind;
  action: ArtifactAction;
  path?: string;
  displayName?: string;
  previewAvailable?: boolean;
};

export type HermesArtifactStore = {
  /**
   * Ingest one classified event for a session. Only `tool` completions that
   * carry a known file/url field produce artifacts (see
   * {@link artifactsFromToolEvent}); everything else is a no-op. `mode` is the
   * session's mode (derive it with `hermesModeFor(sessionId)` at the call site).
   * Total: never throws.
   */
  record(event: JuneHermesEvent, mode: HermesMode): void;
  /**
   * Record an artifact that did not come from a tool event (feature 19's image
   * attach). Same bounding/eviction/dedup and version bump as {@link record};
   * a blank `sessionId` is a no-op. Total: never throws.
   */
  recordArtifact(input: DirectArtifactInput, mode: HermesMode): void;
  /** Drop a session's artifacts entirely (e.g. the user deleted the session). */
  clearSession(sessionId: string): void;
  /** One session's artifacts, newest-first. Empty array if untracked. */
  getRecordsForSession(sessionId: string): AgentArtifact[];
  /** How many artifacts a session has touched (for a drawer count badge). */
  countForSession(sessionId: string): number;
  /** Subscribe to changes (for `useSyncExternalStore`). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Monotonic version, bumped on every mutation (the snapshot getter). */
  getVersion(): number;
};

/**
 * Creates an isolated store instance. The app holds one (see
 * {@link hermesArtifactStore}); tests create their own so state never leaks.
 */
export function createHermesArtifactStore(): HermesArtifactStore {
  // sessionId -> that session's artifacts, oldest-first internally (we append
  // and evict from the front). Insertion order of the outer map drives session
  // eviction, mirroring the activity store.
  const bySession = new Map<string, AgentArtifact[]>();
  const listeners = new Set<() => void>();
  let version = 0;
  let seq = 0;

  function emit(): void {
    version += 1;
    for (const listener of listeners) listener();
  }

  /** Append already-typed partial artifacts onto a session's list, applying the
   * shared dedup/bound/eviction/emit. The single write path both record(...)
   * and recordArtifact(...) funnel through. */
  function appendForSession(
    sessionId: string,
    partials: Array<Omit<AgentArtifact, "id" | "mode" | "createdAt">>,
    mode: HermesMode,
  ): void {
    if (!sessionId || partials.length === 0) return;
    const list = bySession.get(sessionId) ?? [];
    let changed = false;
    for (const partial of partials) {
      // A stable, unique id even when two artifacts share the same path/action
      // within one event (the seq guarantees it).
      seq += 1;
      const artifact: AgentArtifact = {
        ...partial,
        mode,
        id: `${sessionId}:${seq}`,
        createdAt: Date.now(),
      };
      // Collapse a repeat of the same (path, action): keep the latest by
      // dropping the earlier entry. A read-then-edit on one path stays as two
      // distinct rows (different action); a write-then-write collapses to one.
      const dupeIndex = list.findIndex(
        (existing) =>
          existing.action === artifact.action &&
          existing.path === artifact.path &&
          existing.kind === artifact.kind,
      );
      if (dupeIndex !== -1) list.splice(dupeIndex, 1);
      list.push(artifact);
      changed = true;
    }
    if (!changed) return;

    // Bound the per-session list (drop oldest from the front).
    if (list.length > ARTIFACTS_PER_SESSION_CAP) {
      list.splice(0, list.length - ARTIFACTS_PER_SESSION_CAP);
    }

    // Re-key so this session becomes the most-recently-touched for eviction.
    bySession.delete(sessionId);
    bySession.set(sessionId, list);
    evictSessions();
    emit();
  }

  function record(event: JuneHermesEvent, mode: HermesMode): void {
    const extracted = artifactsFromToolEvent(event);
    if (extracted.length === 0) return;
    appendForSession(extracted[0].sessionId, extracted, mode);
  }

  function recordArtifact(input: DirectArtifactInput, mode: HermesMode): void {
    if (!input.sessionId) return;
    appendForSession(
      input.sessionId,
      [
        {
          sessionId: input.sessionId,
          kind: input.kind,
          action: input.action,
          path: input.path,
          displayName: input.displayName,
          previewAvailable: input.previewAvailable,
        },
      ],
      mode,
    );
  }

  function clearSession(sessionId: string): void {
    if (bySession.delete(sessionId)) emit();
  }

  function getRecordsForSession(sessionId: string): AgentArtifact[] {
    const list = bySession.get(sessionId);
    if (!list) return [];
    // Public view is newest-first; internal storage is oldest-first.
    return [...list].reverse();
  }

  function countForSession(sessionId: string): number {
    return bySession.get(sessionId)?.length ?? 0;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getVersion(): number {
    return version;
  }

  function evictSessions(): void {
    while (bySession.size > ARTIFACT_SESSIONS_CAP) {
      const oldest = bySession.keys().next().value;
      if (oldest === undefined) break;
      bySession.delete(oldest);
    }
  }

  return {
    record,
    recordArtifact,
    clearSession,
    getRecordsForSession,
    countForSession,
    subscribe,
    getVersion,
  };
}

/**
 * The app-wide store. AgentWorkspace feeds it from the live gateway
 * subscription (at the existing `classifyHermesEvent` site) and the drawer reads
 * it. A singleton (not React state) so the bounded buffer survives re-renders.
 */
export const hermesArtifactStore = createHermesArtifactStore();

/**
 * Extract file/url artifacts from a classified event. Returns `[]` for anything
 * that isn't a `tool` COMPLETION carrying a known location field.
 *
 * Conservative by design:
 * - Only `tool.complete` events are considered (a started/in-progress tool
 *   hasn't touched anything yet, and would double-count on completion).
 * - Only a small allow-list of payload fields is read (`path`, `file_path`,
 *   `paths`, `url`, …). Free-text fields (`command`, `output`, `text`) are NOT
 *   scanned for path-shaped substrings — a false positive ("the agent touched
 *   /etc/passwd" extracted from a log line) is worse than a miss.
 * - The action is inferred from the tool name (write/create → created, edit →
 *   modified, read → read, download → downloaded, import → downloaded), and any
 *   error field on the payload downgrades it to `failed`.
 *
 * The payload here is already sanitized by the classifier, so secret-bearing
 * fields are redacted before we ever read them.
 */
export function artifactsFromToolEvent(
  event: JuneHermesEvent,
): AgentArtifact[] {
  if (event.kind !== "tool" || event.phase !== "complete") return [];
  const sessionId = nonEmpty(event.sessionId);
  if (!sessionId) return [];

  const payload = asRecord(event.payload);
  if (!payload) return [];

  const locations = locationsFromPayload(payload);
  if (locations.length === 0) return [];

  const failed = hasError(payload);
  const action = failed ? "failed" : actionFromToolName(event.name);

  return locations.map((location) => {
    const kind = kindForLocation(location);
    const seed: AgentArtifact = {
      // id/mode/createdAt are filled in by the store on record; the extractor
      // produces a partial that already typechecks as AgentArtifact so callers
      // (and the store) get full inference. These three are overwritten.
      id: "",
      mode: "sandboxed",
      createdAt: 0,
      sessionId,
      kind,
      action,
      path: location,
      displayName: basename(location),
      previewAvailable: !failed && isPreviewableLocation(location, kind),
      sourceToolCallId: nonEmpty(event.toolCallId),
    };
    return seed;
  });
}

/**
 * Pull location strings out of the known fields, in priority order. Singular
 * fields first, then array fields. Deduped, preserving order.
 */
function locationsFromPayload(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    const str = nonEmpty(typeof value === "string" ? value : undefined);
    if (str && !out.includes(str)) out.push(str);
  };

  for (const key of SINGULAR_LOCATION_KEYS) push(payload[key]);
  // Ambiguous keys (a "destination"/"dest" is just as often a queue name,
  // channel, or host as a file path): only accept their value when it actually
  // looks like a filesystem path or url, so a `send_to_queue {destination:
  // "my-queue"}` never mints a phantom artifact. Conservative by design.
  for (const key of PATH_SHAPED_LOCATION_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && looksLikeLocation(value)) push(value);
  }
  for (const key of ARRAY_LOCATION_KEYS) {
    const value = payload[key];
    if (Array.isArray(value)) for (const item of value) push(item);
  }
  return out;
}

// Known singular payload keys that hold a file path or url. Mirrors the field
// names the rest of the runtime already reads (snake_case + camelCase).
const SINGULAR_LOCATION_KEYS = [
  "path",
  "file_path",
  "filePath",
  "filename",
  "file",
  "target_path",
  "targetPath",
  "url",
  "uri",
] as const;

// Singular keys whose names DON'T guarantee a filesystem meaning. We only treat
// their value as a location when it has a path/url shape (see
// {@link looksLikeLocation}).
const PATH_SHAPED_LOCATION_KEYS = ["destination", "dest"] as const;

// Known array payload keys holding multiple paths.
const ARRAY_LOCATION_KEYS = [
  "paths",
  "file_paths",
  "filePaths",
  "files",
] as const;

/**
 * Infer the action from the tool name. Defaults to `read` (the least-privileged,
 * safest assumption) when the name doesn't clearly indicate a write — we would
 * rather under-claim "the agent changed this" than over-claim it.
 */
function actionFromToolName(name: string | undefined): ArtifactAction {
  const lower = (name ?? "").toLowerCase();
  if (/down(load)?/.test(lower)) return "downloaded";
  if (/import/.test(lower)) return "downloaded";
  if (/(edit|modif|update|patch|append|replace)/.test(lower)) return "modified";
  if (/(write|create|save|generate|export|new)/.test(lower)) return "created";
  if (/(read|cat|open|view|get|fetch|list|search|grep|find)/.test(lower))
    return "read";
  // Unknown tool that nonetheless reported a path: treat as a read so we don't
  // falsely imply a mutation.
  return "read";
}

/** Whether the payload signals the tool call errored. Conservative: only known
 * boolean/string error fields, never inferred from output text. */
function hasError(payload: Record<string, unknown>): boolean {
  if (
    payload.error !== undefined &&
    payload.error !== null &&
    payload.error !== false
  )
    return true;
  if (payload.failed === true) return true;
  const status =
    typeof payload.status === "string" ? payload.status.toLowerCase() : "";
  return status === "error" || status === "failed" || status === "denied";
}

/** Classify a location string into a {@link ArtifactKind}. */
function kindForLocation(location: string): ArtifactKind {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) return "url";
  if (location.endsWith("/") || location.endsWith("\\")) return "directory";
  const base = basename(location);
  if (!base.includes(".")) {
    // No extension and not slash-terminated: could be a dir or an extension-less
    // file. We can't be sure, so call it unknown rather than mislabel.
    return "unknown";
  }
  return isImageExtension(base) ? "image" : "file";
}

function isImageExtension(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|heic|bmp|tiff?)$/i.test(name);
}

/** Whether a string carries a filesystem-path or url shape: a `scheme://`, or a
 * `/` or `\` separator somewhere in it. Used to gate ambiguous payload keys
 * (`destination`/`dest`) so a bare queue/channel/host name doesn't mint an
 * artifact. */
function looksLikeLocation(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return true;
  return trimmed.includes("/") || trimmed.includes("\\");
}

/** A cheap "we could show this inline" hint. The actual preview is fetched
 * lazily by the existing bridge command; this just suppresses a hopeless
 * attempt for, say, a zip or a directory. */
function isPreviewableLocation(location: string, kind: ArtifactKind): boolean {
  if (kind === "directory" || kind === "url") return false;
  if (kind === "image") return true;
  return /\.(txt|md|markdown|mdx|json|ya?ml|toml|csv|tsv|log|ts|tsx|js|jsx|rs|py|go|sh|html?|css)$/i.test(
    location,
  );
}

/** The trailing filename of a path or url, used as the display name. */
function basename(location: string): string {
  // Strip a query/hash off urls first so the name isn't "report.pdf?token=…".
  const withoutQuery = location.split(/[?#]/, 1)[0];
  const trimmed = withoutQuery.replace(/[/\\]+$/, "");
  const lastSlash = Math.max(
    trimmed.lastIndexOf("/"),
    trimmed.lastIndexOf("\\"),
  );
  const base = lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
  return base || location;
}
