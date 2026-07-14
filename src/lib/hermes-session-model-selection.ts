import { LOCAL_GENERATION_OPTION_ID_PREFIX } from "./local-generation";

/**
 * Durable, session-local generation choices, keyed by June's stored session id.
 *
 * A choice can be staged while Hermes is responding, but it is only applied at
 * the next prompt boundary. `revision` makes staging synchronous and
 * latest-wins; `appliedRevision` lets an acknowledgement for an older choice
 * settle without accidentally clearing a newer pending choice.
 */

export const SESSION_MODEL_SELECTION_STORAGE_KEY = "june.agent.sessionModelSelections.v1";
const SESSION_MODEL_SELECTIONS_CHANGED_EVENT = "june:session-model-selections-changed";

export const AUTO_MODEL_ID = "open-software/auto";
export const DEFAULT_AUTO_COST_QUALITY = 100;

/**
 * Reserved internal model id understood by June's on-device provider proxy.
 * It carries Auto's per-run preference through session-scoped `config.set`
 * and is rewritten to `open-software/auto` before leaving the device.
 */
export const AUTO_HERMES_MODEL_ID_PREFIX = "__june_auto_generation__:";
export const REMOTE_HERMES_MODEL_ID_PREFIX = "__june_remote_generation__:";

export type SessionModelSelection = {
  modelId: string;
  costQuality?: number;
};

export type SessionModelSelectionEntry = {
  /** Latest picker choice for the next user-initiated agent run. */
  selection: SessionModelSelection;
  revision: number;
  appliedRevision: number;
  /** Model Hermes is actually configured to use after the last acknowledged write. */
  appliedSelection?: SessionModelSelection;
};

export type SessionModelSelectionMap = Record<string, SessionModelSelectionEntry>;

let canonicalStore: SessionModelSelectionMap = {};
let canonicalHydrated = false;
let persistenceDirty = false;
let lastPersistedRaw: string | null = null;

function normalizedCostQuality(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function normalizedSelection(value: unknown): SessionModelSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { modelId?: unknown; costQuality?: unknown };
  if (typeof candidate.modelId !== "string") return null;
  const modelId = candidate.modelId.trim();
  if (!modelId) return null;
  const costQuality = normalizedCostQuality(candidate.costQuality);
  return costQuality === undefined ? { modelId } : { modelId, costQuality };
}

function normalizedRevision(value: unknown, allowZero: boolean): number | null {
  if (!Number.isSafeInteger(value)) return null;
  const revision = value as number;
  if (revision < (allowZero ? 0 : 1)) return null;
  return revision;
}

function defineEntry(
  store: SessionModelSelectionMap,
  storedSessionId: string,
  entry: SessionModelSelectionEntry,
): void {
  Object.defineProperty(store, storedSessionId, {
    configurable: true,
    enumerable: true,
    value: entry,
    writable: true,
  });
}

function sanitizedMap(value: unknown): SessionModelSelectionMap {
  const store: SessionModelSelectionMap = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return store;

  for (const [rawSessionId, rawEntry] of Object.entries(value)) {
    const storedSessionId = rawSessionId.trim();
    if (!storedSessionId || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      continue;
    }
    const candidate = rawEntry as {
      selection?: unknown;
      revision?: unknown;
      appliedRevision?: unknown;
      appliedSelection?: unknown;
    };
    const selection = normalizedSelection(candidate.selection);
    const explicitAppliedSelection = normalizedSelection(candidate.appliedSelection);
    const revision = normalizedRevision(candidate.revision, false);
    const appliedRevision = normalizedRevision(candidate.appliedRevision, true);
    if (!selection || revision === null || appliedRevision === null) continue;
    const boundedAppliedRevision = Math.min(appliedRevision, revision);

    defineEntry(store, storedSessionId, {
      selection,
      revision,
      appliedRevision: boundedAppliedRevision,
      // A pre-appliedSelection record cannot prove Hermes' live route: older
      // cross-surface sends could finish out of order while the counters still
      // looked fully acknowledged. Leave it unknown so the next Send performs
      // one repairing config.set instead of blessing potentially stale state.
      ...(explicitAppliedSelection ? { appliedSelection: explicitAppliedSelection } : {}),
    });
  }
  return store;
}

function storedSessionIdOrNull(storedSessionId: string): string | null {
  const normalized = storedSessionId.trim();
  return normalized || null;
}

function writeSessionModelSelections(store: SessionModelSelectionMap): void {
  canonicalStore = sanitizedMap(store);
  canonicalHydrated = true;
  const serialized =
    Object.keys(canonicalStore).length === 0 ? null : JSON.stringify(canonicalStore);
  try {
    if (serialized === null) {
      window.localStorage.removeItem(SESSION_MODEL_SELECTION_STORAGE_KEY);
    } else {
      window.localStorage.setItem(SESSION_MODEL_SELECTION_STORAGE_KEY, serialized);
    }
    lastPersistedRaw = serialized;
    persistenceDirty = false;
  } catch {
    // Keep the canonical in-memory map authoritative until persistence
    // recovers. Re-reading stale storage here would regress revisions and let
    // an old acknowledgement clear a newer selection.
    persistenceDirty = true;
  }
  window.dispatchEvent(
    new CustomEvent<SessionModelSelectionMap>(SESSION_MODEL_SELECTIONS_CHANGED_EVENT, {
      detail: sanitizedMap(canonicalStore),
    }),
  );
}

/** Keep AgentWorkspace and NoteChat coherent when both own the same session. */
export function subscribeSessionModelSelections(
  listener: (store: SessionModelSelectionMap) => void,
): () => void {
  const handleChange = (event: Event) => {
    listener((event as CustomEvent<SessionModelSelectionMap>).detail);
  };
  window.addEventListener(SESSION_MODEL_SELECTIONS_CHANGED_EVENT, handleChange);
  return () => window.removeEventListener(SESSION_MODEL_SELECTIONS_CHANGED_EVENT, handleChange);
}

/** Read and sanitize the current persisted map. Malformed storage is ignored. */
export function readSessionModelSelections(): SessionModelSelectionMap {
  try {
    const raw = window.localStorage.getItem(SESSION_MODEL_SELECTION_STORAGE_KEY);
    // Adopt external storage changes whenever memory is clean. While a write
    // is dirty, adopt only a genuinely different persisted value; the old raw
    // snapshot is known stale.
    if (!canonicalHydrated || !persistenceDirty || raw !== lastPersistedRaw) {
      canonicalStore = raw ? sanitizedMap(JSON.parse(raw) as unknown) : {};
      canonicalHydrated = true;
      persistenceDirty = false;
      lastPersistedRaw = raw;
    }
    return sanitizedMap(canonicalStore);
  } catch {
    canonicalHydrated = true;
    return sanitizedMap(canonicalStore);
  }
}

function updateSessionModelSelections(
  update: (store: SessionModelSelectionMap) => void,
): SessionModelSelectionMap {
  if (!canonicalHydrated || !persistenceDirty) readSessionModelSelections();
  const store = sanitizedMap(canonicalStore);
  update(store);
  const sanitized = sanitizedMap(store);
  writeSessionModelSelections(sanitized);
  return sanitized;
}

/** Stage a choice for the next prompt. Repeated calls are synchronous and latest-wins. */
export function stageSessionModelSelection(
  storedSessionId: string,
  selection: SessionModelSelection,
): SessionModelSelectionMap {
  return updateSessionModelSelections((store) => {
    const key = storedSessionIdOrNull(storedSessionId);
    const normalized = normalizedSelection(selection);
    if (!key || !normalized) return;
    const current = store[key];
    defineEntry(store, key, {
      selection: normalized,
      revision: (current?.revision ?? 0) + 1,
      appliedRevision: current?.appliedRevision ?? 0,
      ...(current?.appliedSelection ? { appliedSelection: current.appliedSelection } : {}),
    });
  });
}

/**
 * Remember the choice with which a newly created session already started.
 * The entry is fully applied but still retained for stable display and reloads.
 */
export function rememberAppliedSessionModelSelection(
  storedSessionId: string,
  selection: SessionModelSelection,
): SessionModelSelectionMap {
  return updateSessionModelSelections((store) => {
    const key = storedSessionIdOrNull(storedSessionId);
    const normalized = normalizedSelection(selection);
    if (!key || !normalized) return;
    const current = store[key];
    if (current) {
      const desiredIsApplied = sameSessionModelSelection(current.selection, normalized);
      defineEntry(store, key, {
        ...current,
        appliedRevision: desiredIsApplied ? current.revision : current.appliedRevision,
        appliedSelection: normalized,
      });
      return;
    }
    const revision = 1;
    defineEntry(store, key, {
      selection: normalized,
      revision,
      appliedRevision: revision,
      appliedSelection: normalized,
    });
  });
}

/**
 * Mark the exact revision acknowledged by Hermes. If a newer revision was
 * staged while that request was in flight, its selection remains pending.
 */
export function markSessionModelSelectionApplied(
  storedSessionId: string,
  revision: number,
  appliedSelection: SessionModelSelection,
): SessionModelSelectionMap {
  return updateSessionModelSelections((store) => {
    const key = storedSessionIdOrNull(storedSessionId);
    const acknowledgedRevision = normalizedRevision(revision, false);
    const normalizedAppliedSelection = normalizedSelection(appliedSelection);
    if (!key || acknowledgedRevision === null || !normalizedAppliedSelection) return;
    const current = store[key];
    if (!current || acknowledgedRevision > current.revision) {
      return;
    }
    defineEntry(store, key, {
      ...current,
      appliedRevision: Math.max(current.appliedRevision, acknowledgedRevision),
      appliedSelection: normalizedAppliedSelection,
    });
  });
}

export function hasPendingSessionModelSelection(
  entry: SessionModelSelectionEntry | undefined,
): boolean {
  return Boolean(
    entry &&
      (entry.appliedRevision < entry.revision ||
        !entry.appliedSelection ||
        !sameSessionModelSelection(entry.selection, entry.appliedSelection)),
  );
}

function sameSessionModelSelection(
  left: SessionModelSelection,
  right: SessionModelSelection,
): boolean {
  return left.modelId === right.modelId && left.costQuality === right.costQuality;
}

/** Remove all remembered model state for a deleted stored session. */
export function forgetSessionModelSelection(storedSessionId: string): SessionModelSelectionMap {
  return updateSessionModelSelections((store) => {
    const key = storedSessionIdOrNull(storedSessionId);
    if (key) delete store[key];
  });
}

/** Move a provisional stored-session key to its durable replacement. */
export function migrateSessionModelSelection(
  fromStoredSessionId: string,
  toStoredSessionId: string,
): SessionModelSelectionMap {
  return updateSessionModelSelections((store) => {
    const fromKey = storedSessionIdOrNull(fromStoredSessionId);
    const toKey = storedSessionIdOrNull(toStoredSessionId);
    if (!fromKey || !toKey || fromKey === toKey) return;
    const entry = store[fromKey];
    if (!entry) return;
    delete store[fromKey];
    const destination = store[toKey];
    if (!destination) {
      defineEntry(store, toKey, entry);
      return;
    }

    // A destination can already exist after a recovery/reload race. Rebase the
    // migrated choice above both counters so the destination never moves
    // backward. Preserve whether the migrated choice still needs applying.
    const revision = Math.max(entry.revision, destination.revision) + 1;
    const pending = hasPendingSessionModelSelection(entry);
    defineEntry(store, toKey, {
      selection: entry.selection,
      revision,
      appliedRevision: pending
        ? Math.min(revision - 1, Math.max(entry.appliedRevision, destination.appliedRevision))
        : revision,
      ...(entry.appliedSelection
        ? { appliedSelection: entry.appliedSelection }
        : destination.appliedSelection
          ? { appliedSelection: destination.appliedSelection }
          : {}),
    });
  });
}

/**
 * Convert a catalog choice to the model id Hermes should store for this run.
 * Every remote choice is tagged so the on-device proxy can distinguish it
 * from a local endpoint that happens to expose the same raw model id. Local
 * catalog ids retain their existing tag for the same reason. Auto carries its
 * integer preference so every inference in one agent run keeps the same route.
 */
export function hermesModelIdForSelection(selection: SessionModelSelection): string {
  const normalized = normalizedSelection(selection);
  if (!normalized) return "";
  if (normalized.modelId === AUTO_MODEL_ID) {
    const costQuality = normalized.costQuality ?? DEFAULT_AUTO_COST_QUALITY;
    return `${AUTO_HERMES_MODEL_ID_PREFIX}${costQuality}`;
  }
  if (normalized.modelId.startsWith(LOCAL_GENERATION_OPTION_ID_PREFIX)) {
    return normalized.modelId;
  }
  return `${REMOTE_HERMES_MODEL_ID_PREFIX}${encodeURIComponent(normalized.modelId)}`;
}

/** Decode internal model ids from Hermes for display and session rows. */
export function decodeHermesModelSelection(modelId: string): SessionModelSelection {
  const normalizedModelId = modelId.trim();
  if (normalizedModelId.startsWith(REMOTE_HERMES_MODEL_ID_PREFIX)) {
    try {
      const decoded = decodeURIComponent(
        normalizedModelId.slice(REMOTE_HERMES_MODEL_ID_PREFIX.length),
      ).trim();
      if (decoded) return { modelId: decoded };
    } catch {
      // Keep the opaque value below. A malformed persisted id must not throw
      // while the session list is loading.
    }
  }
  if (!normalizedModelId.startsWith(AUTO_HERMES_MODEL_ID_PREFIX)) {
    return { modelId: normalizedModelId };
  }
  const encoded = normalizedModelId.slice(AUTO_HERMES_MODEL_ID_PREFIX.length);
  const parsed = /^\d{1,3}$/.test(encoded) ? Number.parseInt(encoded, 10) : Number.NaN;
  return {
    modelId: AUTO_MODEL_ID,
    costQuality: normalizedCostQuality(parsed) ?? DEFAULT_AUTO_COST_QUALITY,
  };
}
