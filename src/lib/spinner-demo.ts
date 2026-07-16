// Dev-only coordinator for inspecting June's shared spinner in representative
// production contexts from one console command:
//
//   window.__spinnerDemo()       show sidebar, gallery, HUD, and toast samples
//   window.__spinnerDemo(false)  clear every sample
//
// The individual surfaces keep owning their own preview state. This module
// composes those existing drivers so it never starts a real request, mutates
// user data, or creates a second presentation-only version of a spinner.

import { toast } from "../components/ui/Toaster";
import { AGENT_HUD_VISIBILITY_CHANGED_EVENT, getAgentHudEnabled } from "./agent-hud-settings";

type SpinnerDemoWindow = Window & {
  __agentGallery?: (show?: boolean) => unknown;
  __agentHud?: (state?: string, count?: number) => unknown;
  __sidebarStates?: (show?: boolean) => unknown;
  __spinnerDemo?: (show?: boolean) => string;
};

export type SpinnerDemoApi = {
  dispose: () => void;
};

const GALLERY_SPINNER_SELECTOR = ".agent-gallery .agent-tool-spinner";
const GALLERY_SCROLL_ATTEMPTS = 12;

function emitAgentHudVisibility(enabled: boolean) {
  void import("@tauri-apps/api/event")
    .then(({ emit }) => emit(AGENT_HUD_VISIBILITY_CHANGED_EVENT, { enabled }))
    .catch(() => {});
}

export function registerSpinnerDemo(): SpinnerDemoApi {
  const target = window as SpinnerDemoWindow;
  let active = false;
  let loadingToastId: string | number | undefined;
  let scrollTimer: number | undefined;

  function cancelGalleryScroll() {
    if (scrollTimer === undefined) return;
    window.clearTimeout(scrollTimer);
    scrollTimer = undefined;
  }

  function focusGallerySpinner() {
    cancelGalleryScroll();
    let attempts = 0;
    const focus = () => {
      scrollTimer = undefined;
      const spinner = document.querySelector<HTMLElement>(GALLERY_SPINNER_SELECTOR);
      if (spinner) {
        spinner.scrollIntoView?.({ block: "center" });
        return;
      }
      attempts += 1;
      if (attempts < GALLERY_SCROLL_ATTEMPTS) {
        scrollTimer = window.setTimeout(focus, 16);
      }
    };
    scrollTimer = window.setTimeout(focus, 0);
  }

  function clear() {
    cancelGalleryScroll();
    target.__agentHud?.("clear");
    target.__agentGallery?.(false);
    target.__sidebarStates?.(false);
    if (loadingToastId !== undefined) {
      toast.dismiss(loadingToastId);
      loadingToastId = undefined;
    }
    // The demo may temporarily reveal a disabled HUD, but never changes the
    // saved preference. Teardown returns the Agent HUD to the current setting.
    emitAgentHudVisibility(getAgentHudEnabled());
    active = false;
  }

  const run = (show: boolean = true) => {
    if (!show) {
      clear();
      return "Spinner demo cleared.";
    }

    active = true;
    target.__sidebarStates?.(true);
    target.__agentGallery?.(true);
    // "mixed" auto-expands the Agent HUD, exposing its running-row spinners.
    // A transient visibility event also reveals it when the saved preference
    // is off; clear() restores that preference without rewriting localStorage.
    emitAgentHudVisibility(true);
    target.__agentHud?.("mixed");
    loadingToastId ??= toast.loading("Spinner showcase");
    focusGallerySpinner();

    return "Spinner demo shown: sidebar, Agent gallery, Agent HUD, and loading toast. Run __spinnerDemo(false) to clear.";
  };

  target.__spinnerDemo = run;

  return {
    dispose() {
      if (active) clear();
      if (target.__spinnerDemo === run) delete target.__spinnerDemo;
    },
  };
}
