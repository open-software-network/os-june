import type { UnlistenFn } from "@tauri-apps/api/event";

type Cleanup = () => void;

export function createHudLifecycle() {
  const abortController = new AbortController();
  const animationFrameHandles = new Set<number>();
  const cleanups = new Set<Cleanup>();
  let disposed = false;

  const addCleanup = (cleanup: Cleanup) => {
    if (disposed) {
      cleanup();
      return;
    }
    cleanups.add(cleanup);
  };

  const trackUnlisten = (unlistenPromise: Promise<UnlistenFn>) => {
    void unlistenPromise.then(addCleanup).catch(() => {});
  };

  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    if (disposed) return 0;
    let handle = 0;
    handle = window.requestAnimationFrame((time) => {
      animationFrameHandles.delete(handle);
      callback(time);
    });
    animationFrameHandles.add(handle);
    return handle;
  };

  const cancelAnimationFrame = (handle: number) => {
    animationFrameHandles.delete(handle);
    window.cancelAnimationFrame(handle);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    abortController.abort();
    for (const handle of animationFrameHandles) {
      window.cancelAnimationFrame(handle);
    }
    animationFrameHandles.clear();
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // Continue releasing the rest of the window-owned resources.
      }
    }
    cleanups.clear();
  };

  // Tauri WKWebView teardown can surface through either browser lifecycle
  // event, so both paths share the same idempotent disposer.
  window.addEventListener("beforeunload", dispose, {
    once: true,
    signal: abortController.signal,
  });
  window.addEventListener("pagehide", dispose, {
    once: true,
    signal: abortController.signal,
  });

  return {
    addCleanup,
    cancelAnimationFrame,
    requestAnimationFrame,
    signal: abortController.signal,
    trackUnlisten,
  };
}
