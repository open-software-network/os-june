import { IconBubble3 } from "central-icons/IconBubble3";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconProjects } from "central-icons/IconProjects";
import { IconSettingsGear4 } from "central-icons/IconSettingsGear4";
import { IconZap } from "central-icons/IconZap";
import type { ReactNode } from "react";
import type { FolderDto, HermesSessionInfo, NoteDto, NoteListItemDto } from "../lib/tauri";
import { navEquals, type TabNav } from "./tabs/tabs";
// "June is up to date." is a confirmation, not a call to action: linger, then
// hide on its own. Failures persist until dismissed; busy statuses advance
// when their operation resolves and may also be dismissed while in flight.
export const UP_TO_DATE_DISMISS_MS = 4000;
// Soft-exit window: the update-popover-out animation runs var(--t-med) (160ms);
// the status clears just after it finishes.
export const UP_TO_DATE_EXIT_MS = 220;

export const SIDEBAR_DEFAULT_WIDTH = 240;
export const SIDEBAR_MIN_WIDTH = 188;
export const SIDEBAR_MAX_WIDTH = 320;
export const SIDEBAR_COLLAPSE_WIDTH = 160;
export const CHECK_FOR_UPDATES_EVENT = "june://check-for-updates";
export const AGENT_MENU_BAR_SESSION_FETCH_LIMIT = 100;
export const AGENT_MENU_BAR_SESSION_LIMIT = 6;
export const AGENT_MENU_BAR_SESSION_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000];
// Matches the Routines view's run-history cadence; a routine notification a
// few seconds late is fine, hammering the bridge is not.
export const ROUTINE_RUN_NOTIFY_POLL_MS = 15000;
export const ACCESSIBILITY_PERMISSION_REFRESH_INTERVAL_MS = 1000;
export const SYSTEM_AUDIO_PERMISSION_REFRESH_INTERVAL_MS = 1000;
export const SYSTEM_AUDIO_PERMISSION_REFRESH_TIMEOUT_MS = 120_000;
export const MEETING_START_LISTENER_RETRY_DELAYS_MS = [250, 1_000, 5_000] as const;
export const MEETING_START_REQUEST_EXPIRED_MESSAGE =
  "Recording did not start in time. Open meeting notes and select Record to try again.";
export const COMPOSER_FUNDING_DISABLED_REASON =
  "Add credits to send messages or generate images and videos.";
export const RECORDING_FUNDING_DISABLED_REASON =
  "Add credits before starting a recording. You can still browse and edit.";
export const NOTE_RETRY_FUNDING_DISABLED_REASON = "Add credits before retrying note generation.";
export const RECOVERY_FUNDING_DISABLED_REASON =
  "Add credits before recovering this recording. Your saved audio will stay available.";
export const ROUTINE_FUNDING_DISABLED_REASON = "Add credits before running a routine.";
// Floor for the note card so the sidebar can't be dragged wide enough to
// crush it into a sliver — it always keeps a usable width plus its gutters.
export const MAIN_PANEL_MIN_WIDTH = 420;

export function noteHasDownloadableAudio(note: NoteDto): boolean {
  const audioSources = note.audioSources?.length
    ? note.audioSources
    : note.audio
      ? [note.audio]
      : [];
  return audioSources.some((audio) => audio.format === "wav" && audio.sizeBytes > 0);
}

// Largest the sidebar may grow given the live window width: never past its own
// cap, and never so far that the main panel drops below its floor. Falls back
// to the sidebar min on very narrow windows where both can't be satisfied.
export function sidebarMaxWidth() {
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth - MAIN_PANEL_MIN_WIDTH),
  );
}

export const TAB_ICON_SIZE = 14;

export type RecordingInactivityPrompt = {
  sessionId: string;
  expiresAt: number;
};

export type AgentRecorderRequestPayload = {
  requestId?: unknown;
  action?: unknown;
  sourceMode?: unknown;
};

export function agentSessionTabTitle(session?: HermesSessionInfo): string | undefined {
  return session?.title?.trim() || session?.preview?.trim() || undefined;
}

export function refreshedTabNav(current: TabNav, live: TabNav): TabNav | undefined {
  if (!navEquals(current, live)) return live;
  if (current.view !== "agent" || live.view !== "agent") return undefined;

  const liveTitle = live.agentSessionTitle?.trim();
  if (!liveTitle || current.agentSessionTitle?.trim() === liveTitle) {
    return undefined;
  }

  return { ...current, agentSessionTitle: liveTitle };
}

// The icon + label a tab shows for a snapshot. Titles for entity views (note,
// project, agent session) are looked up live from the loaded data, so a tab's
// label tracks renames. Agent tabs also carry a fallback title so a newly
// created session is identifiable before the session list hydrates.
export function tabMeta(
  nav: TabNav,
  notes: NoteListItemDto[],
  folders: FolderDto[],
  sessions: HermesSessionInfo[],
  settingsSectionLabel?: string,
): { title: string; icon: ReactNode } {
  switch (nav.view) {
    case "meetings": {
      const note = nav.noteId ? notes.find((n) => n.id === nav.noteId) : undefined;
      return {
        title: note?.title?.trim() || "New note",
        icon: <IconNoteText size={TAB_ICON_SIZE} />,
      };
    }
    case "folders": {
      const folder = nav.folderId ? folders.find((f) => f.id === nav.folderId) : undefined;
      return {
        title: folder?.name?.trim() || "Projects",
        icon: <IconProjects size={TAB_ICON_SIZE} />,
      };
    }
    case "agent": {
      const session = nav.agentSessionId
        ? sessions.find((s) => s.id === nav.agentSessionId)
        : undefined;
      return {
        title: agentSessionTabTitle(session) || nav.agentSessionTitle?.trim() || "New session",
        icon: <IconBubble3 size={TAB_ICON_SIZE} />,
      };
    }
    case "agent-sessions":
      return {
        title: "Sessions",
        icon: <IconBubble3 size={TAB_ICON_SIZE} />,
      };
    case "all-notes":
      return {
        title: "All notes",
        icon: <IconNoteText size={TAB_ICON_SIZE} />,
      };
    case "routines":
      return {
        title: "Routines",
        icon: <IconZap size={TAB_ICON_SIZE} />,
      };
    case "dictation":
      return {
        title: "Dictation",
        icon: <IconMicrophone size={TAB_ICON_SIZE} />,
      };
    case "settings":
      return {
        // Surface the active settings section (e.g. "MCP servers") in the tab
        // strip so the label says what you are looking at, not just "Settings".
        title: settingsSectionLabel?.trim() || "Settings",
        icon: <IconSettingsGear4 size={TAB_ICON_SIZE} />,
      };
    case "notes":
    default:
      return {
        title: "Notes",
        icon: <IconNoteText size={TAB_ICON_SIZE} />,
      };
  }
}
