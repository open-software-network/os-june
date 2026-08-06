// Dev-only console driver for the archived-sessions surfaces: the status
// filter (Active / Archived / All) on the sessions page, and the sidebar
// list the archived sessions leave.
//
//   window.__completedDemo("seed")        5 active + 4 archived sessions
//   window.__completedDemo("seed", 12)    ...with 12 archived
//   window.__completedDemo("clear")       remove the demo sessions
//
// It seeds synthetic sessions straight into app state (no backend), marking a
// slice of them in the Clovy-owned completed_at map ("archived" is the
// user-facing term, see CONTEXT.md), so both surfaces render in a plain
// browser with no agent runtime. Demo ids share a prefix so re-runs replace
// and "clear" removes only demo rows; a reload clears everything.
// Mirrors the dev drivers in lib/processing-progress-demo.ts.
//
// Never bundled in production: the dynamic import is gated on
// import.meta.env.DEV.

import type { AgentSessionDto } from "./agent-runtime-contract";
import {
  COMPLETED_DEMO_SESSION_PREFIX,
  SIDEBAR_DEMO_SESSIONS_EVENT,
  type SidebarDemoSessionsDetail,
} from "./completed-sessions-demo-ids";

export type CompletedSessionsDemoApi = {
  /** Remove the window hook. */
  dispose: () => void;
};

const ACTIVE_TITLES = [
  "Prep board update",
  "Digest of unread PRs",
  "Compare CRM options",
  "Draft launch announcement",
  "Summarize support threads",
];

const COMPLETED_TITLES = [
  "Book flights to Lisbon",
  "Q2 expense sweep",
  "Rename design tokens",
  "File taxes checklist",
  "Migrate notes to projects",
  "Research standing desks",
  "Clean up downloads folder",
  "Triage onboarding feedback",
  "Write referral copy",
  "Archive old meeting notes",
  "Compare password managers",
  "Plan offsite agenda",
];

function buildSession(id: string, title: string, ageHours: number): AgentSessionDto {
  const updated = new Date(Date.now() - ageHours * 3_600_000);
  const created = new Date(updated.getTime() - 40 * 60_000);
  return {
    id,
    title,
    status: "completed",
    model: "gpt-5.2",
    safetyMode: "sandboxed",
    workspacePath: "",
    source: "user",
    createdAt: created.toISOString(),
    updatedAt: updated.toISOString(),
  };
}

function buildDemoData(completedCount: number): {
  sessions: AgentSessionDto[];
  completedAt: Record<string, string>;
} {
  const sessions: AgentSessionDto[] = [];
  const completedAt: Record<string, string> = {};

  ACTIVE_TITLES.forEach((title, index) => {
    sessions.push(
      buildSession(`${COMPLETED_DEMO_SESSION_PREFIX}active-${index}`, title, index + 1),
    );
  });

  for (let index = 0; index < completedCount; index += 1) {
    const title = COMPLETED_TITLES[index % COMPLETED_TITLES.length] ?? "Completed session";
    const session = buildSession(
      `${COMPLETED_DEMO_SESSION_PREFIX}done-${index}`,
      index < COMPLETED_TITLES.length
        ? title
        : `${title} ${Math.floor(index / COMPLETED_TITLES.length) + 1}`,
      12 + index * 7,
    );
    sessions.push(session);
    completedAt[session.id] = session.updatedAt;
  }

  return { sessions, completedAt };
}

const HELP = [
  "Archived sessions demo (sessions page status filter):",
  '  __completedDemo("seed")      5 active + 4 archived sessions',
  '  __completedDemo("seed", 12)  ...with 12 archived',
  '  __completedDemo("clear")     remove the demo sessions',
  "",
  "Seeds in-memory sessions only. Reload to remove everything. Dev only.",
].join("\n");

export function registerCompletedSessionsDemo({
  seedSessions,
  clearSessions,
}: {
  /** Merge the demo sessions into app state and mark the completed slice. */
  seedSessions: (sessions: AgentSessionDto[], completedAt: Record<string, string>) => void;
  /** Remove every session whose id starts with the demo prefix. */
  clearSessions: (idPrefix: string) => void;
}): CompletedSessionsDemoApi {
  // The Sidebar keeps its own session list (partition-scoped, ADR 0031), so
  // every seed/clear also broadcasts to its dev listener.
  function broadcastToSidebar(sessions?: AgentSessionDto[]) {
    window.dispatchEvent(
      new CustomEvent<SidebarDemoSessionsDetail>(SIDEBAR_DEMO_SESSIONS_EVENT, {
        detail: { clearPrefix: COMPLETED_DEMO_SESSION_PREFIX, sessions },
      }),
    );
  }

  const hook = (command?: "seed" | "clear", completedCount?: number) => {
    switch (command) {
      case "seed": {
        const count = Math.max(1, Math.floor(completedCount ?? 4));
        clearSessions(COMPLETED_DEMO_SESSION_PREFIX);
        const { sessions, completedAt } = buildDemoData(count);
        seedSessions(sessions, completedAt);
        broadcastToSidebar(sessions);
        return `Seeded ${ACTIVE_TITLES.length} active + ${count} archived sessions. Open Sessions and flip the status filter to Archived; __completedDemo("clear") to remove.`;
      }
      case "clear":
        clearSessions(COMPLETED_DEMO_SESSION_PREFIX);
        broadcastToSidebar();
        return "Demo sessions removed.";
      default:
        return HELP;
    }
  };

  (window as unknown as Record<string, unknown>).__completedDemo = hook;

  function dispose() {
    delete (window as unknown as Record<string, unknown>).__completedDemo;
  }

  return { dispose };
}
