import React from "react";
import ReactDOM from "react-dom/client";
import { Agentation } from "agentation";
import { App } from "./app/App";
import { installNativeContextMenuGuard } from "./lib/native-context-menu";
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
if (import.meta.env.DEV) {
  window.june = { replayOnboarding };
}

initTheme();
installNativeContextMenuGuard();

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
  // __dictationHud("listening") drives the dictation pill in the same HUD
  // window over the Tauri bus.
  void import("./lib/dictation-hud-demo").then(({ registerDictationHudDemo }) =>
    registerDictationHudDemo({ local: false }),
  );
  // __recordingHud("recording") drives the recording pill (meeting-hud window)
  // over the Tauri bus. Note: that window only shows when Rust already has a
  // live recording with the main window hidden — see lib/recording-hud-demo.ts.
  void import("./lib/recording-hud-demo").then(({ registerRecordingHudDemo }) =>
    registerRecordingHudDemo({ local: false }),
  );
  // __emptyStates() forces every list view (Agents, Routines, Projects,
  // Notes, Dictation, sidebar) into its empty rendering for design work;
  // call again or __emptyStates(false) to reset. Real data is untouched.
  void import("./lib/empty-states-demo").then(({ registerEmptyStatesDemo }) =>
    registerEmptyStatesDemo(),
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    {import.meta.env.DEV ? <Agentation /> : null}
  </React.StrictMode>,
);
