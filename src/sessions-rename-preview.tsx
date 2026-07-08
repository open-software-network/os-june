// Dev-only preview entry: renders the real AgentSessionsList against the faked
// Tauri bridge in sessions-rename-preview.html so the sidebar rename flow can
// be driven and recorded in a plain browser (no native build). The rename
// handler mirrors App.tsx's handleRenameAgentSession: local state update plus
// a best-effort ensure_hermes_bridge_session persistence call (logged by the
// fake bridge). Nothing here ships: vite builds only the configured entries.
import { useState } from "react";
import ReactDOM from "react-dom/client";
import { AgentSessionsList } from "./components/agent/AgentSessionsList";
import { ensureHermesBridgeSession, type HermesSessionInfo } from "./lib/tauri";
import { initTheme } from "./lib/theme";
import "./styles/app.css";

initTheme();

const initialSessions: HermesSessionInfo[] = [
  {
    id: "session-1",
    title: "Untitled session",
    preview: "Can you look at the flaky checkout test?",
    last_active: "2026-07-07T09:12:00Z",
    message_count: 6,
  },
  {
    id: "session-2",
    title: "Fix payment retries",
    preview: "Retries now back off exponentially",
    last_active: "2026-07-06T16:40:00Z",
    message_count: 12,
  },
  {
    id: "session-3",
    title: "Summarize sprint notes",
    preview: "Drafted the sprint summary",
    last_active: "2026-07-05T11:05:00Z",
    message_count: 4,
  },
];

function Preview() {
  const [sessions, setSessions] = useState(initialSessions);
  return (
    <div style={{ height: "100vh", display: "flex" }}>
      <AgentSessionsList
        sessions={sessions}
        folders={[]}
        sessionFolderIds={{}}
        onSelectSession={() => {}}
        onNewSession={() => {}}
        onRenameSession={(sessionId, title) => {
          setSessions((current) =>
            current.map((session) => (session.id === sessionId ? { ...session, title } : session)),
          );
          void ensureHermesBridgeSession({ sessionId, title }).catch(() => {});
        }}
        onOpenMoveDialog={() => {}}
        onOpenMoveSessions={() => {}}
        onRemoveFromProject={() => {}}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Preview />);
