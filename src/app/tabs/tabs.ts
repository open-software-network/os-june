import type { SidebarView } from "../../components/sidebar/Sidebar";

// Where an agent session was drilled into from — mirrors the live `agentOrigin`
// state in App so a restored agent tab rebuilds the same breadcrumb chrome.
export type AgentOrigin = { kind: "project"; folderId: string } | { kind: "routines" };

// A navigation snapshot: everything needed to re-render a view exactly as the
// user left it. Each open tab owns one of these. Fields are gated by `view`
// (a note id is meaningless on the Routines view), which keeps `navEquals`
// stable — only the fields that matter for a view participate in equality.
export type TabNav = {
  view: SidebarView;
  // view === "meetings"
  noteId?: string;
  originFolderId?: string;
  originAllNotes?: boolean;
  // view === "folders"
  folderId?: string;
  // view === "agent"
  agentSessionId?: string;
  agentSessionTitle?: string;
  agentOrigin?: AgentOrigin;
};

export type Tab = {
  id: string;
  nav: TabNav;
};

// A fresh tab lands on the agent hero — a new chat. The caller arms the
// new-session handshake so the workspace opens on the hero rather than
// restoring the last conversation.
export function defaultNav(): TabNav {
  return { view: "agent" };
}

export function makeTabId(): string {
  // crypto.randomUUID is available in the WKWebView runtime; the fallback keeps
  // unit tests (jsdom without crypto) from throwing.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tab-${Math.random().toString(36).slice(2)}`;
}

// Apply a drag-reorder of the on-strip tabs. `orderedVisibleIds` is the strip's
// visible tabs in their new left-to-right order; they become the leading prefix
// of the full array (so re-layout reproduces the strip exactly, even when the
// active tab had been pinned onto the strip from overflow), and the remaining
// tabs follow in their existing relative order.
export function reorderTabs(tabs: Tab[], orderedVisibleIds: string[]): Tab[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ordered = [...new Set(orderedVisibleIds)].filter((id) => byId.has(id));
  const orderedSet = new Set(ordered);
  const next = [
    ...ordered.map((id) => byId.get(id)!),
    ...tabs.filter((tab) => !orderedSet.has(tab.id)),
  ];
  if (next.every((tab, index) => tab === tabs[index])) return tabs;
  return next;
}

function agentOriginEquals(a?: AgentOrigin, b?: AgentOrigin): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "project" && b.kind === "project") {
    return a.folderId === b.folderId;
  }
  return true;
}

// Equality scoped to the fields that matter for the given view, so the capture
// effect doesn't churn the active tab when irrelevant live state shifts.
export function navEquals(a: TabNav, b: TabNav): boolean {
  if (a.view !== b.view) return false;
  switch (a.view) {
    case "meetings":
      return (
        a.noteId === b.noteId &&
        a.originFolderId === b.originFolderId &&
        !!a.originAllNotes === !!b.originAllNotes
      );
    case "folders":
      return a.folderId === b.folderId;
    case "agent":
      return (
        a.agentSessionId === b.agentSessionId && agentOriginEquals(a.agentOrigin, b.agentOrigin)
      );
    default:
      return true;
  }
}
