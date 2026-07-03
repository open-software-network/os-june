// Dev-only preview entry: renders the real AgentWorkspace against the faked
// Tauri bridge in agent-image-preview.html so the /image affordance can be
// driven and screenshotted in a plain browser (no native build). Nothing here
// ships: vite builds only the entries listed in vite.config rollupOptions.
import ReactDOM from "react-dom/client";
import { AgentWorkspace } from "./components/agent/AgentWorkspace";
import { initTheme } from "./lib/theme";
import "./styles/app.css";

initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <div style={{ height: "100vh", display: "flex" }}>
    <AgentWorkspace />
  </div>,
);
