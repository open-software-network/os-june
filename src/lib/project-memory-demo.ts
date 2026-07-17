// Dev-only console driver for the Memory manager (Settings > Memory):
// window.__projectMemoryDemo() drops a handful of sample memories into the
// manager — spread across real projects — so the populated state (rows, project
// tags, sources, the two-line clamp + expand, search + filter) can be designed
// without waiting for the agent to write real ones. __projectMemoryDemo(false)
// — or calling it again — clears.
//
// The hook is imported unconditionally by the section (the flag stays false in
// production); only the console command registration is gated on
// import.meta.env.DEV, in main.tsx.

import { useSyncExternalStore } from "react";
import type { MemoryDto } from "./tauri";

const PROJECT_MEMORY_DEMO_EVENT = "june:project-memory-demo-changed";

const DEMO_MEMORIES: MemoryDto[] = [
  {
    id: "demo-1",
    folderId: "demo",
    content: "The launch is targeted for Friday, and legal still needs to sign off on the copy.",
    source: "agent",
    createdAt: "2026-07-14T16:00:00Z",
    updatedAt: "2026-07-14T16:00:00Z",
  },
  {
    id: "demo-2",
    folderId: "demo",
    content:
      "Prefers short, skimmable summaries with the decision up top, then the reasoning underneath — and always call out anything that's still an open question rather than smoothing over it.",
    source: "agent",
    createdAt: "2026-07-12T09:30:00Z",
    updatedAt: "2026-07-12T09:30:00Z",
  },
  {
    id: "demo-3",
    folderId: "demo",
    content: "Sam owns pricing; loop them in before quoting numbers to the client.",
    source: "user",
    createdAt: "2026-07-10T14:15:00Z",
    updatedAt: "2026-07-10T14:15:00Z",
  },
];

let active = false;

function subscribe(onChange: () => void) {
  window.addEventListener(PROJECT_MEMORY_DEMO_EVENT, onChange);
  return () => window.removeEventListener(PROJECT_MEMORY_DEMO_EVENT, onChange);
}

/** Sample memories while __projectMemoryDemo() is on, otherwise null. */
export function useProjectMemoryDemo(): MemoryDto[] | null {
  return useSyncExternalStore(
    subscribe,
    () => (active ? DEMO_MEMORIES : null),
    () => null,
  );
}

export function registerProjectMemoryDemo() {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__projectMemoryDemo = (on?: boolean) => {
    active = on ?? !active;
    window.dispatchEvent(new Event(PROJECT_MEMORY_DEMO_EVENT));
    return active
      ? "Sample memories shown in Settings > Memory. __projectMemoryDemo(false) to reset."
      : "Back to real memories.";
  };
}
