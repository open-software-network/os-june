import { useEffect, useState } from "react";
import { isMacLikePlatform, isWindowsLikePlatform } from "./platform";
import { getPlatformCapabilities, type PlatformCapabilities } from "./tauri";

// Capabilities are static per build, so the first successful backend answer
// is cached for the lifetime of the app and every later read is synchronous.
let cached: PlatformCapabilities | undefined;
let pending: Promise<PlatformCapabilities> | undefined;

/**
 * Best-guess capabilities from a user-agent sniff, used only until the
 * backend answers (and in browser previews, where there is no backend).
 * Kept in sync with `get_platform_capabilities` in
 * `src-tauri/src/commands.rs` so the reconcile is a no-op on real builds.
 */
export function fallbackPlatformCapabilities(): PlatformCapabilities {
  const mac = isMacLikePlatform();
  return {
    systemAudio: true,
    meetingDetection: mac || isWindowsLikePlatform(),
    dictation: mac,
  };
}

/** The backend-reported capabilities when they have already been fetched;
 * undefined before the first successful read. */
export function cachedPlatformCapabilities(): PlatformCapabilities | undefined {
  return cached;
}

/**
 * Resolves the backend-reported capabilities, sharing one in-flight IPC call
 * and caching the answer forever (the values are compile-time constants on
 * the Rust side). An IPC failure resolves to the sniffed fallback but is not
 * cached, so a later call can still pick up the real backend verdict.
 */
export function platformCapabilities(): Promise<PlatformCapabilities> {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    // Wrapped in a resolved-promise chain so a synchronous throw from invoke
    // (e.g. no Tauri runtime) lands in the catch instead of escaping.
    pending = Promise.resolve()
      .then(() => getPlatformCapabilities())
      .then((capabilities) => {
        cached = capabilities;
        return capabilities;
      })
      .catch(() => {
        pending = undefined;
        return fallbackPlatformCapabilities();
      });
  }
  return pending;
}

/**
 * The running build's capabilities for render-time gating. Starts from the
 * cached backend answer when available, otherwise from the sniffed fallback
 * (so the first paint matches the eventual answer on every shipping
 * platform and nothing flashes), then reconciles once the IPC read lands.
 */
export function usePlatformCapabilities(): PlatformCapabilities {
  const [capabilities, setCapabilities] = useState(() => cached ?? fallbackPlatformCapabilities());
  useEffect(() => {
    let active = true;
    void platformCapabilities().then((next) => {
      if (!active) return;
      // Skip the state write when the fallback already matched, so settled
      // surfaces do not re-render.
      setCapabilities((prev) =>
        prev.systemAudio === next.systemAudio &&
        prev.meetingDetection === next.meetingDetection &&
        prev.dictation === next.dictation
          ? prev
          : next,
      );
    });
    return () => {
      active = false;
    };
  }, []);
  return capabilities;
}
