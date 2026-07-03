// Dev-only preview entry: mounts the real AgentWorkspace with app styles.
import React from "react";
import ReactDOM from "react-dom/client";
import { AgentWorkspace } from "/src/components/agent/AgentWorkspace";
import { initTheme } from "/src/lib/theme";
import "/src/styles/app.css";

initTheme();
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AgentWorkspace />
  </React.StrictMode>,
);
