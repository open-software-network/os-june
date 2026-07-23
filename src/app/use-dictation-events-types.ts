import { type SidebarView } from "../components/sidebar/Sidebar";
import type * as React from "react";

export type UseDictationEventsDependencies = {
  dictationWorkflowActiveRef: React.MutableRefObject<boolean>;
  setAccessibilityStatus: React.Dispatch<React.SetStateAction<string | undefined>>;
  setActiveView: React.Dispatch<React.SetStateAction<SidebarView>>;
  setMicrophoneStatus: React.Dispatch<React.SetStateAction<string | undefined>>;
};
