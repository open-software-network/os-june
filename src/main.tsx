import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { initTheme } from "./lib/theme";
import "./styles/app.css";

initTheme();

// Console driver for the agent HUD overlay window: __agentHud("demo") etc.
// from this window's devtools. Emits on the Tauri bus only, so fake demo
// sessions never leak into the sidebar or menu bar. See lib/agent-hud-demo.ts.
if (import.meta.env.DEV) {
  void import("./lib/agent-hud-demo").then(({ registerAgentHudDemo }) =>
    registerAgentHudDemo({ local: false }),
  );
  // Same pattern for the meeting-detection prompt: __meetingHud("detected")
  // drives the real dictation HUD window over the Tauri bus.
  void import("./lib/meeting-hud-demo").then(({ registerMeetingHudDemo }) =>
    registerMeetingHudDemo({ local: false }),
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
