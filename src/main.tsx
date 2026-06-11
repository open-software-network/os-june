import React from "react";
import ReactDOM from "react-dom/client";
import { Agentation } from "agentation";
import { App } from "./app/App";
import { replayOnboarding } from "./lib/onboarding";
import { initTheme } from "./lib/theme";
import "./styles/app.css";

declare global {
  interface Window {
    /** Devtools-console testing hooks; not referenced by app code. */
    june?: { replayOnboarding: typeof replayOnboarding };
  }
}

// `june.replayOnboarding()` in the webview console re-runs the wizard;
// pass a step id ("trial", "permissions", ...) to land on that step.
window.june = { replayOnboarding };

initTheme();

// Console driver for the agent HUD overlay window: __agentHud("demo") etc.
// from this window's devtools. Emits on the Tauri bus only, so fake demo
// sessions never leak into the sidebar or menu bar. See lib/agent-hud-demo.ts.
if (import.meta.env.DEV) {
  void import("./lib/agent-hud-demo").then(({ registerAgentHudDemo }) =>
    registerAgentHudDemo({ local: false }),
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    {import.meta.env.DEV ? <Agentation /> : null}
  </React.StrictMode>,
);
