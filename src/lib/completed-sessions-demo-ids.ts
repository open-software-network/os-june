// Shared between the Sidebar (which owns its local session list) and the
// __completedDemo console driver (lib/completed-sessions-demo.ts), so the
// demo can reach both the app-level state and the sidebar's store. Kept in
// its own module (like app/processing-demo-ids.ts) so neither side has to
// import the other.

import type { AgentSessionDto } from "./agent-runtime-contract";

export const COMPLETED_DEMO_SESSION_PREFIX = "completed-demo-";

export const SIDEBAR_DEMO_SESSIONS_EVENT = "clovy:sidebar:demo-sessions";

export type SidebarDemoSessionsDetail = {
  /** Sessions with this id prefix are removed before any new ones merge in. */
  clearPrefix: string;
  sessions?: AgentSessionDto[];
};
