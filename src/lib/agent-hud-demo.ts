// Dev-only console driver for the agent HUD: window.__agentHud("waiting"),
// __agentHud("running", 3), __agentHud("demo"), ... Lets you park the HUD in
// any state or run a scripted lifecycle without real agent sessions.
//
// Two contexts, one command:
// - Main window devtools (Tauri dev app): events go out on the Tauri bus
//   only, driving the real overlay window. Window events are deliberately
//   NOT dispatched here — the sidebar and menu bar listen to those, and
//   fake sessions must not leak into real app state.
// - The standalone page (pnpm dev, open /agent-hud.html in a browser):
//   events dispatch locally as window events; the Tauri bridge is absent.
//
// Never bundled in production: both registration sites gate the dynamic
// import on import.meta.env.DEV.

import {
  AGENT_SESSIONS_CHANGED_EVENT,
  AGENT_SESSION_STATUS_EVENT,
  type AgentSessionStatusDetail,
  type AgentSessionsChangedDetail,
} from "./agent-events";
import type { HermesSessionInfo } from "./tauri";

type AgentHudDemoOptions = {
  /** Dispatch window events on this page instead of emitting on the Tauri
   * bus. True on the standalone agent-hud.html page. */
  local: boolean;
};

type DemoState =
  | "running"
  | "waiting"
  | "mixed"
  | "done"
  | "failed"
  | "stopped"
  | "demo"
  | "clear";

const HELP = [
  "Agent HUD demo states:",
  '  __agentHud("running", n?)  n sessions working (default 1)',
  '  __agentHud("waiting")      one session needs input (expands, reply testable)',
  '  __agentHud("mixed")        two running + one needing input',
  '  __agentHud("done")         a session just finished (fades out after ~2s)',
  '  __agentHud("failed")       a session hit a problem (lingers ~8s)',
  '  __agentHud("stopped")      a session was cancelled',
  '  __agentHud("demo")         scripted lifecycle: start, run, need input, finish',
  '  __agentHud("clear")        reset and hide the HUD',
].join("\n");

const SESSION_BLUEPRINTS = [
  {
    title: "Refactor the trial gate copy",
    summary: "Rewriting the paywall states.",
  },
  {
    title: "Sweep typographic dashes",
    summary: "Checking 14 files for em-dashes.",
  },
  {
    title: "Fix the flaky shortcut test",
    summary: "Bisecting the timer mock.",
  },
] as const;

const WAITING_BLUEPRINT = {
  title: "Migrate the notes schema",
  summary: "Wants approval before running migrations.",
} as const;

let timers: number[] = [];

export function registerAgentHudDemo({ local }: AgentHudDemoOptions) {
  if (typeof window === "undefined") return;

  function emitStatus(detail: AgentSessionStatusDetail) {
    if (local) {
      window.dispatchEvent(
        new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
          detail,
        }),
      );
      return;
    }
    void import("@tauri-apps/api/event")
      .then((api) => api.emit(AGENT_SESSION_STATUS_EVENT, detail))
      .catch(() => {});
  }

  function emitSessions(detail: AgentSessionsChangedDetail) {
    if (local) {
      window.dispatchEvent(
        new CustomEvent<AgentSessionsChangedDetail>(
          AGENT_SESSIONS_CHANGED_EVENT,
          { detail },
        ),
      );
      return;
    }
    void import("@tauri-apps/api/event")
      .then((api) => api.emit(AGENT_SESSIONS_CHANGED_EVENT, detail))
      .catch(() => {});
  }

  function session(index: number, title: string): HermesSessionInfo {
    const now = new Date().toISOString();
    return {
      id: `hud-demo-${index}`,
      title,
      preview: title,
      started_at: now,
      last_active: now,
      message_count: 2,
    };
  }

  function cancelTimers() {
    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
  }

  function at(delayMs: number, run: () => void) {
    timers.push(window.setTimeout(run, delayMs));
  }

  function clear() {
    cancelTimers();
    emitSessions({
      sessions: [],
      workingSessionIds: [],
      waitingSessionIds: [],
    });
  }

  function park(runningCount: number, waitingCount: number) {
    cancelTimers();
    const running = SESSION_BLUEPRINTS.slice(0, runningCount).map(
      (blueprint, index) => ({
        ...blueprint,
        session: session(index + 1, blueprint.title),
      }),
    );
    const waiting = waitingCount
      ? [
          {
            ...WAITING_BLUEPRINT,
            session: session(99, WAITING_BLUEPRINT.title),
          },
        ]
      : [];
    emitSessions({
      sessions: [...running, ...waiting].map((entry) => entry.session),
      workingSessionIds: running.map((entry) => entry.session.id),
      waitingSessionIds: waiting.map((entry) => entry.session.id),
    });
    for (const entry of running) {
      emitStatus({
        sessionId: entry.session.id,
        status: "running",
        title: entry.title,
        summary: entry.summary,
      });
    }
    for (const entry of waiting) {
      emitStatus({
        sessionId: entry.session.id,
        status: "waitingForUser",
        title: entry.title,
        summary: entry.summary,
      });
    }
  }

  function terminal(status: "completed" | "failed" | "cancelled") {
    clear();
    emitStatus({
      status,
      title: SESSION_BLUEPRINTS[0].title,
      summary:
        status === "failed" ? "Tests failed on the second run." : undefined,
      activeCount: 0,
    });
  }

  function demo() {
    clear();
    emitStatus({
      status: "received",
      title: "Let's start a session.",
      summary: "Starting June.",
    });
    at(1500, () => park(2, 0));
    at(5000, () => park(1, 1));
    at(13000, () => {
      park(1, 0);
      emitStatus({
        sessionId: "hud-demo-99",
        status: "completed",
        title: WAITING_BLUEPRINT.title,
        activeCount: 1,
      });
    });
    at(16000, () => {
      emitSessions({
        sessions: [session(1, SESSION_BLUEPRINTS[0].title)],
        workingSessionIds: [],
        waitingSessionIds: [],
      });
      emitStatus({
        sessionId: "hud-demo-1",
        status: "completed",
        title: SESSION_BLUEPRINTS[0].title,
        activeCount: 0,
      });
    });
    return "Lifecycle running (~18s): start, 2 running, needs input, done, fade out.";
  }

  (window as unknown as Record<string, unknown>).__agentHud = (
    state?: DemoState,
    count = 1,
  ) => {
    switch (state) {
      case "running":
        park(Math.max(1, Math.min(count, SESSION_BLUEPRINTS.length)), 0);
        return `${count} running. __agentHud("clear") to reset.`;
      case "waiting":
        park(0, 1);
        return 'Needs input: the HUD expands itself; try the reply. __agentHud("clear") to reset.';
      case "mixed":
        park(2, 1);
        return 'Two running, one needs input. __agentHud("clear") to reset.';
      case "done":
        terminal("completed");
        return "Done: fades out after ~2s.";
      case "failed":
        terminal("failed");
        return "Failed: lingers ~8s (hover to keep it).";
      case "stopped":
        terminal("cancelled");
        return "Stopped: fades out after ~2s.";
      case "demo":
        return demo();
      case "clear":
        clear();
        return "Cleared.";
      default:
        return HELP;
    }
  };
}
