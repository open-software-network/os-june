// Dev-only preview entry: renders the real AgentSessionsList against the faked
// Tauri bridge in sessions-rename-preview.html so the sidebar rename flow can
// be driven and recorded in a plain browser (no native build). The rename
// handler mirrors App.tsx's handleRenameAgentSession: local state update plus
// a best-effort June-owned session rename persistence call (logged by the
// fake bridge). Nothing here ships: vite builds only the configured entries.
import { useState } from "react";
import ReactDOM from "react-dom/client";
import { AgentSessionsList } from "./components/agent/AgentSessionsList";
import { renameAgentSession } from "./lib/tauri";
import type { AgentSessionDto } from "./lib/agent-runtime-contract";
import { initTheme } from "./lib/theme";
import "./styles/app.css";

initTheme();

const initialSessions: AgentSessionDto[] = [
  {
    id: "session-1",
    title: "Untitled session",
    status: "idle",
    model: "auto",
    safetyMode: "sandboxed",
    workspacePath: "",
    source: "user",
    createdAt: "2026-07-07T09:12:00Z",
    updatedAt: "2026-07-07T09:12:00Z",
  },
  {
    id: "session-2",
    title: "Fix payment retries",
    status: "completed",
    model: "auto",
    safetyMode: "sandboxed",
    workspacePath: "",
    source: "user",
    createdAt: "2026-07-06T16:40:00Z",
    updatedAt: "2026-07-06T16:40:00Z",
  },
  {
    id: "session-3",
    title: "Summarize sprint notes",
    status: "completed",
    model: "auto",
    safetyMode: "sandboxed",
    workspacePath: "",
    source: "user",
    createdAt: "2026-07-05T11:05:00Z",
    updatedAt: "2026-07-05T11:05:00Z",
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
          void renameAgentSession(sessionId, title).catch(() => {});
        }}
        onOpenMoveDialog={() => {}}
        onOpenMoveSessions={() => {}}
        onRemoveFromProject={() => {}}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Preview />);
