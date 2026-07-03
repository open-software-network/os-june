// Dev-only console driver for empty states: window.__emptyStates() toggles
// every list view (Agents, Routines, Projects, Notes, Dictation, the sidebar
// agent section) into its "nothing here yet" rendering regardless of real
// data, so empty states can be inspected and designed without wiping local
// data. __emptyStates(false) — or calling it again — flips back.
//
// The hook is imported unconditionally by the views (the flag simply stays
// false in production); only the console command registration is gated on
// import.meta.env.DEV, in main.tsx.

import { useSyncExternalStore } from "react";

const EMPTY_STATES_DEMO_EVENT = "june:empty-states-demo-changed";

let forced = false;

function subscribe(onChange: () => void) {
  window.addEventListener(EMPTY_STATES_DEMO_EVENT, onChange);
  return () => window.removeEventListener(EMPTY_STATES_DEMO_EVENT, onChange);
}

/** True while __emptyStates() is forcing every view's empty rendering. */
export function useForcedEmptyStates(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => forced,
    () => false,
  );
}

export function registerEmptyStatesDemo() {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__emptyStates = (on?: boolean) => {
    forced = on ?? !forced;
    window.dispatchEvent(new Event(EMPTY_STATES_DEMO_EVENT));
    return forced
      ? "Empty states forced across the app. __emptyStates(false) to reset."
      : "Back to real data.";
  };
}
