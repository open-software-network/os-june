import React from "react";
import ReactDOM from "react-dom/client";
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
