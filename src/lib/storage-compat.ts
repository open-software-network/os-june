const INSTALL_MARKER = Symbol.for("co.opensoftware.clovy.storage-compat-installed");

type StoragePrototypeWithMarker = Storage & { [INSTALL_MARKER]?: true };

export function legacyStorageKey(key: string): string | undefined {
  if (key.startsWith("os-clovy:")) return `os-june:${key.slice("os-clovy:".length)}`;
  if (key.startsWith("os-clovy.")) return `os-june.${key.slice("os-clovy.".length)}`;
  if (key.startsWith("clovy:")) return `june:${key.slice("clovy:".length)}`;
  if (key.startsWith("clovy.")) return `june.${key.slice("clovy.".length)}`;
  return undefined;
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
    if (canonical !== null) {
      try {
        Reflect.apply(setItem, this, [legacyKey, canonical]);
      } catch {
        // A failed repair must never hide a readable preference.
      }
      return canonical;
    }

    const legacy = Reflect.apply(getItem, this, [legacyKey]) as string | null;
    if (legacy !== null) {
      try {
        Reflect.apply(setItem, this, [key, legacy]);
      } catch {
        // Copy-on-read is retried on the next access.
      }
    }
    return legacy;
  };

  prototype.setItem = function setCompatibleItem(key: string, value: string): void {
    const legacyKey = legacyStorageKey(key);
    if (!legacyKey) {
      Reflect.apply(setItem, this, [key, value]);
      return;
    }

    let legacyError: unknown;
    let canonicalError: unknown;
    try {
      Reflect.apply(setItem, this, [legacyKey, value]);
    } catch (error) {
      legacyError = error;
    }
    try {
      Reflect.apply(setItem, this, [key, value]);
    } catch (error) {
      canonicalError = error;
    }
    if (canonicalError) throw canonicalError;
    if (legacyError) throw legacyError;
  };

  prototype.removeItem = function removeCompatibleItem(key: string): void {
    const legacyKey = legacyStorageKey(key);
    if (!legacyKey) {
      Reflect.apply(removeItem, this, [key]);
      return;
    }

    let canonicalError: unknown;
    let legacyError: unknown;
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
    if (canonicalError) throw canonicalError;
    if (legacyError) throw legacyError;
  };

  Object.defineProperty(prototype, INSTALL_MARKER, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
}
