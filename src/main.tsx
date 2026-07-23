import React from "react";
import ReactDOM from "react-dom/client";
import { Agentation } from "agentation";
import { App } from "./app/App";
import { Toaster } from "./components/ui/Toaster";
import { installNativeContextMenuGuard } from "./lib/native-context-menu";
import { replayOnboarding } from "./lib/onboarding";
import { initTheme } from "./lib/theme";
import { initBrand } from "./lib/brand";
import { initFontScale, installFontScaleShortcuts } from "./lib/font-scale";
import { installExternalLinkOpener } from "./lib/external-links";
import { initializeExperimentalFlags } from "./lib/experimental-flags";
import { isMacLikePlatform, isWindowsPlatform } from "./lib/platform";
import { preloadInitialWorkspace } from "./app/workspace-lazy";
import "./styles/app.css";

declare global {
  interface Window {
    /** Devtools-console testing hooks; not referenced by app code. */
    june?: { replayOnboarding: typeof replayOnboarding };
  }
}

// `june.replayOnboarding()` in the webview console re-runs the wizard;
// pass a step id ("permissions", "dictation-practice", ...) to land on that step.
if (import.meta.env.DEV) {
  window.june = { replayOnboarding };
}

initTheme();
initBrand();
initFontScale();
installFontScaleShortcuts();
installExternalLinkOpener();
installNativeContextMenuGuard();
await Promise.all([
  initializeExperimentalFlags(),
  isMacLikePlatform() || isWindowsPlatform() ? preloadInitialWorkspace() : Promise.resolve(),
]);

// Console driver for the agent HUD overlay window: __agentHud("demo") etc.
// from this window's devtools. Emits on the Tauri bus only, so fake demo
// sessions never leak into the sidebar or menu bar. See lib/agent-hud-demo.ts.
if (import.meta.env.DEV) {
  void import("./lib/agent-hud-demo").then(({ registerAgentHudDemo }) => {
    registerAgentHudDemo({ local: false });
    // Composite visual check: __spinnerDemo() opens representative real
    // spinner contexts, including this separately rendered HUD window.
    void import("./lib/spinner-demo").then(({ registerSpinnerDemo }) => registerSpinnerDemo());
  });
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
  // __billingDemo("pro") parks the Account → Billing card in any plan state;
  // __billingDemo("all") stacks every variant; __billingDemo("off") resets.
  void import("./lib/billing-demo").then(({ registerBillingDemo }) => registerBillingDemo());
  // __usageDemo("half") parks the session usage panel in any state;
  // __usageDemo("off") resets.
  void import("./lib/usage-panel-demo").then(({ registerUsagePanelDemo }) =>
    registerUsagePanelDemo(),
  );
  // __projectMemoryDemo() drops sample memories into an open Project settings
  // dialog so the populated memory list can be designed; call again to reset.
  void import("./lib/project-memory-demo").then(({ registerProjectMemoryDemo }) =>
    registerProjectMemoryDemo(),
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    {/* Global toast host. Sonner mounts a real in-flow <section> (no portal),
        so it must live outside App's .app-shell grid: an in-flow child there
        auto-places into an implicit second grid row and steals height from
        the main column once the sidebar collapses (JUN-237). The toast list
        itself is position: fixed, so it renders identically from here. */}
    <Toaster />
    {import.meta.env.DEV ? <Agentation /> : null}
  </React.StrictMode>,
);
