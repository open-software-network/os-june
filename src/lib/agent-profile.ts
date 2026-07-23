import { useSyncExternalStore } from "react";

type Listener = () => void;

export type ActiveAgentProfile = {
  name: string;
  confirmed: boolean;
};

export const DEFAULT_AGENT_PROFILE = "default";
export const PROFILE_DATA_CHANGED_EVENT = "june:profile-data-changed";
const ACTIVE_PROFILE_STORAGE_KEY = "june:active-agent-profile";

export type ProfileDataChangedDetail = { profile: string };

let activeProfileName = storedProfileName();
let snapshot: ActiveAgentProfile = { name: activeProfileName, confirmed: true };
const listeners = new Set<Listener>();

function normalizeProfileName(name: string | null | undefined) {
  return name?.trim() || DEFAULT_AGENT_PROFILE;
}

function storedProfileName() {
  try {
    return normalizeProfileName(window.localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY));
  } catch {
    return DEFAULT_AGENT_PROFILE;
  }
}

function emit() {
  for (const listener of listeners) listener();
}

export function dispatchProfileDataChanged(profile: string) {
  window.dispatchEvent(
    new CustomEvent<ProfileDataChangedDetail>(PROFILE_DATA_CHANGED_EVENT, {
      detail: { profile: normalizeProfileName(profile) },
    }),
  );
}

export function getActiveAgentProfileName() {
  return activeProfileName;
}

export function getActiveAgentProfile() {
  return snapshot;
}

export function isActiveAgentProfileConfirmed() {
  return true;
}

export function useActiveAgentProfile() {
  return useSyncExternalStore(subscribe, getActiveAgentProfile, getActiveAgentProfile);
}

export function useActiveAgentProfileName() {
  return useActiveAgentProfile().name;
}

export function setActiveAgentProfileName(name: string) {
  const next = normalizeProfileName(name);
  if (next === activeProfileName) return;
  activeProfileName = next;
  snapshot = { name: next, confirmed: true };
  try {
    window.localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, next);
  } catch {
    // Restricted WebViews may not expose storage. The in-memory profile still works.
  }
  emit();
}

export function refreshActiveAgentProfile() {
  setActiveAgentProfileName(storedProfileName());
  return Promise.resolve(activeProfileName);
}

export function resetActiveAgentProfileForTests() {
  activeProfileName = DEFAULT_AGENT_PROFILE;
  snapshot = { name: activeProfileName, confirmed: true };
}

export function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
