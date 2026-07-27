import { describe, expect, it } from "vitest";
import { buildAgentMenuBarState } from "../lib/menu-bar";
import type { AgentSessionDto } from "../lib/agent-runtime-contract";

const sessions: AgentSessionDto[] = [
  {
    id: "session-old",
    title: "Older work",
    status: "idle",
    model: "auto",
    safetyMode: "sandboxed",
    workspacePath: "",
    source: "user",
    createdAt: "2026-06-04T11:00:00Z",
    updatedAt: "2026-06-04T12:00:00Z",
  },
  {
    id: "session-new",
    title: "Newer work",
    status: "idle",
    model: "auto",
    safetyMode: "sandboxed",
    workspacePath: "",
    source: "user",
    createdAt: "2026-06-04T11:00:00Z",
    updatedAt: "2026-06-04T13:00:00Z",
  },
];

describe("buildAgentMenuBarState", () => {
  it("summarizes active counts and orders recent sessions", () => {
    const state = buildAgentMenuBarState({
      sessions,
      workingSessionIds: new Set(["session-old"]),
      waitingSessionIds: new Set(["session-new"]),
      now: new Date("2026-06-04T14:00:00Z"),
    });

    expect(state.activeCount).toBe(2);
    expect(state.needsUserCount).toBe(1);
    expect(state.agentHudEnabled).toBe(true);
    expect(state.sessions.map((session) => session.id)).toEqual(["session-new", "session-old"]);
    expect(state.sessions[0]).toMatchObject({
      title: "Newer work",
      status: "waitingForUser",
    });
    expect(state.sessions[1]).toMatchObject({
      title: "Older work",
      status: "running",
    });
  });

  it("keeps waiting sessions visible before recent idle sessions", () => {
    const recentIdleSessions: AgentSessionDto[] = Array.from({ length: 6 }, (_, index) => ({
      id: `idle-${index}`,
      title: `Idle ${index}`,
      status: "idle",
      model: "auto",
      safetyMode: "sandboxed",
      workspacePath: "",
      source: "user",
      createdAt: "2026-06-04T12:00:00Z",
      updatedAt: `2026-06-04T13:0${index}:00Z`,
    }));
    const state = buildAgentMenuBarState({
      sessions: [
        ...recentIdleSessions,
        {
          id: "waiting-old",
          title: "Waiting on approval",
          status: "waiting_for_user",
          model: "auto",
          safetyMode: "sandboxed",
          workspacePath: "",
          source: "user",
          createdAt: "2026-06-04T11:00:00Z",
          updatedAt: "2026-06-04T12:00:00Z",
        },
      ],
      workingSessionIds: new Set(),
      waitingSessionIds: new Set(["waiting-old"]),
      limit: 6,
      now: new Date("2026-06-04T14:00:00Z"),
    });

    expect(state.needsUserCount).toBe(1);
    expect(state.sessions).toHaveLength(6);
    expect(state.sessions[0]).toMatchObject({
      id: "waiting-old",
      status: "waitingForUser",
    });
  });

  it("keeps the last status summary when no session exists yet", () => {
    const state = buildAgentMenuBarState({
      sessions: [],
      workingSessionIds: new Set(),
      waitingSessionIds: new Set(),
      lastStatus: {
        prompt: "Make a launch checklist",
        status: "starting",
        summary: "Starting June.",
      },
      now: new Date("2026-06-04T14:00:00Z"),
    });

    expect(state.activeCount).toBe(0);
    expect(state.sessions).toEqual([]);
    expect(state.lastStatus).toMatchObject({
      title: "Make a launch checklist",
      status: "starting",
      summary: "Starting June.",
    });
  });

  it("includes the agent HUD visibility preference", () => {
    const state = buildAgentMenuBarState({
      sessions: [],
      workingSessionIds: new Set(),
      waitingSessionIds: new Set(),
      agentHudEnabled: false,
      now: new Date("2026-06-04T14:00:00Z"),
    });

    expect(state.agentHudEnabled).toBe(false);
  });
});
