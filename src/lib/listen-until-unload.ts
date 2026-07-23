import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";

// `listen()` registers on the native Tauri event bus, which outlives the
// webview. The HUD windows are destroyed and recreated throughout a session,
// so a module-scope `void listen(...)` leaves one stale registration behind
// per recreation - growing per-event fan-out and memory until quit. This
// wrapper keeps every unlisten handle and releases them all when the page
// unloads.
const unlisteners: UnlistenFn[] = [];
let unloadHookInstalled = false;

export function listenUntilUnload<T>(event: string, handler: EventCallback<T>): void {
  if (!unloadHookInstalled) {
    unloadHookInstalled = true;
    window.addEventListener("beforeunload", () => {
      for (const unlisten of unlisteners.splice(0)) unlisten();
    });
  }
  void listen<T>(event, handler)
    .then((unlisten) => {
      unlisteners.push(unlisten);
    })
    .catch(() => {});
}
