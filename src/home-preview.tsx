// Dev-only preview entry: renders the real AgentWorkspace in homeMode against
// the faked Tauri bridge in home-preview.html so the Home thread can be driven
// and screenshotted in a plain browser (no native build). Nothing here ships:
// vite builds only the entries listed in vite.config rollupOptions.
import ReactDOM from "react-dom/client";
import { AgentWorkspace } from "./components/agent/AgentWorkspace";
import { initTheme } from "./lib/theme";
import "./styles/app.css";

initTheme();

// The wrapper mirrors the app shell's structural classes so scroll-driven
// CSS (the named --main-panel-scroll timeline and its scope) activates in
// the preview exactly as in the app.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <div className="main-panel" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <div
      className="main-panel-body"
      data-active-view="home"
      style={{ display: "flex", flex: 1, minHeight: 0 }}
    >
      <div className="workspace" style={{ display: "flex", flex: 1, minWidth: 0 }}>
        <AgentWorkspace homeMode initialSessionId="home-session" />
      </div>
    </div>
  </div>,
);
