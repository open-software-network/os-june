// Dev-only console driver for the sidebar profile switcher:
// window.__profileSwitcherDemo() forces a fake multi-profile manager state
// into the identity menu so the switcher renders (and switches, with a
// simulated in-flight beat) in a plain browser with no Hermes runtime.
// __profileSwitcherDemo(false) — or calling it again — flips back.
// __profileSwitcherDemo(["default", "work"]) seeds custom names (the second
// entry starts active, mirroring a named-profile session).
//
// The fake state never touches the app-global active-profile store or any
// Tauri command, so real session stamping and data scoping are unaffected.
//
// The hook is imported unconditionally by the sidebar (the state simply stays
// null in production); only the console command registration is gated on
// import.meta.env.DEV, in main.tsx.

import { useSyncExternalStore } from "react";
import type { ProfileManagerState } from "./hermes-admin";

const PROFILE_SWITCHER_DEMO_EVENT = "june:profile-switcher-demo-changed";

const DEFAULT_DEMO_NAMES = ["default", "work", "research"];

let demoState: ProfileManagerState | null = null;

function emit() {
  window.dispatchEvent(new Event(PROFILE_SWITCHER_DEMO_EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener(PROFILE_SWITCHER_DEMO_EVENT, onChange);
  return () => window.removeEventListener(PROFILE_SWITCHER_DEMO_EVENT, onChange);
}

function buildDemoState(names: string[]): ProfileManagerState {
  return {
    status: "ready",
    profiles: names.map((name) => ({ name, raw: {} })),
    activeName: names[1] ?? names[0] ?? "default",
    activeConfirmed: true,
    pendingAction: null,
    pendingRemoval: null,
    error: null,
    activate(name: string) {
      if (!demoState) return Promise.resolve(false);
      demoState = { ...demoState, pendingAction: { kind: "activate", name } };
      emit();
      // A visible in-flight beat, long enough to judge the spinner state.
      return new Promise((resolve) => {
        setTimeout(() => {
          if (!demoState) return resolve(false);
          demoState = { ...demoState, pendingAction: null, activeName: name };
          emit();
          resolve(true);
        }, 450);
      });
    },
    beginRemove: () => Promise.resolve(false),
    confirmRemoval: () => Promise.resolve(false),
    cancelRemoval: () => {},
    refresh: () => {},
    dismissError: () => {},
  };
}

/** The forced switcher state while __profileSwitcherDemo() is on, else null. */
export function useForcedProfileSwitcherState(): ProfileManagerState | null {
  return useSyncExternalStore(
    subscribe,
    () => demoState,
    () => null,
  );
}

export function registerProfileSwitcherDemo() {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__profileSwitcherDemo = (
    input?: boolean | string[],
  ) => {
    if (input === false || (demoState && input === undefined)) {
      demoState = null;
      emit();
      return "Back to real profiles.";
    }
    const names = Array.isArray(input) && input.length > 0 ? input : DEFAULT_DEMO_NAMES;
    demoState = buildDemoState(names);
    emit();
    return `Sidebar profile switcher forced with ${names.length} profiles. Open the account menu; __profileSwitcherDemo(false) to reset.`;
  };
}
