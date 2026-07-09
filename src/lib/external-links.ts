// External-link rescue for the Tauri webview. The webview installs no
// new-window handler, so `target="_blank"` anchors — the natural way to write
// an external link, used across settings, onboarding, and agent markdown —
// are silently dropped in the native shell while working fine in browser dev.
// Rather than teaching each component to call a command, this installs ONE
// document-level click interceptor that routes external http(s) anchor clicks
// through `june_open_external_url` (which opens the default browser).
//
// Only installed when running inside Tauri; in a plain browser the anchors'
// native behavior already works. Handlers that preventDefault (e.g. a future
// command-backed link) are respected and skipped.

import { invoke } from "@tauri-apps/api/core";

function inTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function installExternalLinkOpener() {
  if (!inTauri()) return;

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented) return;
    const anchor = (event.target as Element | null)?.closest?.("a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    // Links inside an editable surface (the TipTap note editor / composer) are
    // being edited, not followed — clicking one places the caret.
    if (anchor.isContentEditable) return;

    let url: URL;
    try {
      url = new URL(anchor.href, window.location.href);
    } catch {
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    // In-app navigation (same origin, no _blank) stays with the router.
    const external = anchor.target === "_blank" || url.origin !== window.location.origin;
    if (!external) return;

    event.preventDefault();
    void invoke("june_open_external_url", { url: url.href }).catch(() => {
      // Best-effort: a failed open leaves the click a no-op, same as before.
    });
  });
}
