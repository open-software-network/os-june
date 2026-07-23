import { describe, expect, it } from "vitest";
import type { AgentSessionDto } from "../lib/agent-runtime-contract";
import {
  filterAgentSessionsForProfile,
  sessionMatchesProfile,
  sessionProfileMap,
} from "../lib/session-profile-filter";

function session(id: string): AgentSessionDto {
  return {
    id,
    title: id,
    status: "idle",
    model: "auto",
    safetyMode: "sandboxed",
    workspacePath: "",
    source: "user",
    createdAt: "2026-07-22T12:00:00Z",
    updatedAt: "2026-07-22T12:00:00Z",
  };
}

describe("session profile filtering", () => {
  it("keeps June-owned sessions in their assigned profile", () => {
    const sessions = [session("work-session"), session("default-session")];
    const profiles = sessionProfileMap([{ sessionId: "work-session", profile: "work" }]);

    expect(filterAgentSessionsForProfile(sessions, profiles, "work").map(({ id }) => id)).toEqual([
      "work-session",
    ]);
    expect(
      filterAgentSessionsForProfile(sessions, profiles, "default").map(({ id }) => id),
    ).toEqual(["default-session"]);
    expect(sessionMatchesProfile(sessions[0], profiles, "work")).toBe(true);
  });
});
