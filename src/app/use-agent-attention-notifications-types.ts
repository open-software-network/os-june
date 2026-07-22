import { type SidebarView } from "../components/sidebar/Sidebar";
import type { RecordingStatusDto } from "../lib/tauri";
import type * as React from "react";

export type UseAgentAttentionNotificationsDependencies = {
  activeAgentSessionIdRef: React.MutableRefObject<string | undefined>;
  activeViewRef: React.MutableRefObject<SidebarView>;
  agentHudEnabledRef: React.MutableRefObject<boolean>;
  dictationWorkflowActiveRef: React.MutableRefObject<boolean>;
  noteChatOpenRef: React.MutableRefObject<boolean>;
  noteChatSessionIdRef: React.MutableRefObject<string | undefined>;
  recordingStatusRef: React.MutableRefObject<RecordingStatusDto | undefined>;
};
