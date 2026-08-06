const INSTALL_MARKER = Symbol.for("co.opensoftware.clovy.storage-compat-installed");
const SYNC_MARKER_PREFIX = "__clovy_storage_compat_sync__:";

type StoragePrototypeWithMarker = Storage & { [INSTALL_MARKER]?: true };
type StorageWrite = (key: string, value: string) => void;

function syncMarkerKey(canonicalKey: string): string {
  return `${SYNC_MARKER_PREFIX}${canonicalKey}`;
}

function valueFingerprint(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${value.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

export function legacyStorageKey(key: string): string | undefined {
  if (key.startsWith("os-clovy:")) return `os-june:${key.slice("os-clovy:".length)}`;
  if (key.startsWith("os-clovy.")) return `os-june.${key.slice("os-clovy.".length)}`;
  if (key.startsWith("clovy:")) return `june:${key.slice("clovy:".length)}`;
  if (key.startsWith("clovy.")) return `june.${key.slice("clovy.".length)}`;
  return undefined;
}

export function writeCompatibleStorageValue(
  write: StorageWrite,
  canonicalKey: string,
  legacyKey: string,
  value: string,
): void {
  // Canonical is the commit point because reads prefer it. If the legacy
  // write fails or the process stops between calls, the next read repairs
  // the rollback key from the committed canonical value.
  write(canonicalKey, value);
  write(legacyKey, value);
  write(syncMarkerKey(canonicalKey), valueFingerprint(value));
}

/**
 * Keep browser preferences readable by both Clovy and a rollback build.
 *
 * Storage is patched at the platform primitive because preferences are spread
 * across the main window and three HUD entry points. The bridge is deliberately
 * narrow: only Clovy-canonical prefixes receive a June-era alias.
 */
export function installStorageCompatibilityBridge(): void {
  if (typeof Storage === "undefined") return;
  const prototype = Storage.prototype as StoragePrototypeWithMarker;
  if (prototype[INSTALL_MARKER]) return;

  const getItem = prototype.getItem;
  const setItem = prototype.setItem;
  const removeItem = prototype.removeItem;

  prototype.getItem = function getCompatibleItem(key: string): string | null {
    const legacyKey = legacyStorageKey(key);
    if (!legacyKey) return Reflect.apply(getItem, this, [key]) as string | null;

    const canonical = Reflect.apply(getItem, this, [key]) as string | null;
    let legacy: string | null;
    try {
      legacy = Reflect.apply(getItem, this, [legacyKey]) as string | null;
    } catch (error) {
      if (canonical !== null) return canonical;
      throw error;
    }

    const markerKey = syncMarkerKey(key);
    let priorFingerprint: string | null = null;
    try {
      priorFingerprint = Reflect.apply(getItem, this, [markerKey]) as string | null;
    } catch {
      // The canonical value remains authoritative when marker storage is
      // unavailable. A later read can retry reconciliation.
    }

    if (canonical !== null && legacy !== null) {
      const canonicalFingerprint = valueFingerprint(canonical);
      const legacyFingerprint = valueFingerprint(legacy);
      const legacyChangedAfterSync =
        priorFingerprint === canonicalFingerprint && priorFingerprint !== legacyFingerprint;
      const value = legacyChangedAfterSync ? legacy : canonical;
      const repairKey = legacyChangedAfterSync ? key : legacyKey;
      try {
        Reflect.apply(setItem, this, [repairKey, value]);
        Reflect.apply(setItem, this, [markerKey, valueFingerprint(value)]);
      } catch {
        // A failed repair must never hide a readable preference.
      }
      return value;
    }

    const existing = canonical ?? legacy;
    if (existing !== null) {
      // Once both keys have been observed in sync, one disappearing means a
      // rollback or partially completed Clovy delete removed it. Propagate
      // that deletion instead of resurrecting the remaining stale value.
      if (priorFingerprint === valueFingerprint(existing)) {
        try {
          Reflect.apply(removeItem, this, [key]);
          Reflect.apply(removeItem, this, [legacyKey]);
          Reflect.apply(removeItem, this, [markerKey]);
          return null;
        } catch {
          return existing;
        }
      }

      const repairKey = canonical === null ? key : legacyKey;
      try {
        Reflect.apply(setItem, this, [repairKey, existing]);
        Reflect.apply(setItem, this, [markerKey, valueFingerprint(existing)]);
      } catch {
        // Copy-on-read is retried on the next access.
      }
      return existing;
    }

    try {
      Reflect.apply(removeItem, this, [markerKey]);
    } catch {
      // Stale marker cleanup is best effort.
    }
    return null;
  };

  prototype.setItem = function setCompatibleItem(key: string, value: string): void {
    const legacyKey = legacyStorageKey(key);
    if (!legacyKey) {
      Reflect.apply(setItem, this, [key, value]);
      return;
    }

    writeCompatibleStorageValue(
      (targetKey, targetValue) => Reflect.apply(setItem, this, [targetKey, targetValue]),
      key,
      legacyKey,
      value,
    );
  };

  prototype.removeItem = function removeCompatibleItem(key: string): void {
    const legacyKey = legacyStorageKey(key);
    if (!legacyKey) {
      Reflect.apply(removeItem, this, [key]);
      return;
    }

    let canonicalError: unknown;
    let legacyError: unknown;
    let markerError: unknown;
    const markerKey = syncMarkerKey(key);
    try {
      Reflect.apply(removeItem, this, [key]);
    } catch (error) {
      canonicalError = error;
    }
    try {
      Reflect.apply(removeItem, this, [legacyKey]);
    } catch (error) {
      legacyError = error;
    }
    if (!canonicalError && !legacyError) {
      try {
        Reflect.apply(removeItem, this, [markerKey]);
      } catch (error) {
        markerError = error;
      }
    }
    if (canonicalError) throw canonicalError;
    if (legacyError) throw legacyError;
    if (markerError) throw markerError;
  };

  Object.defineProperty(prototype, INSTALL_MARKER, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
}
