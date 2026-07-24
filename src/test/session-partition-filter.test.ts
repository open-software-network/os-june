import { describe, expect, it } from "vitest";
import type { AgentSessionDto } from "../lib/agent-runtime-contract";
import {
  filterAgentSessionsForDataPartition,
  sessionMatchesDataPartition,
  sessionPartitionMap,
} from "../lib/session-partition-filter";

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

describe("session data partition filtering", () => {
  it("keeps June-owned sessions in their assigned data partition", () => {
    const sessions = [session("work-session"), session("default-session")];
    const partitions = sessionPartitionMap([{ sessionId: "work-session", profile: "work" }]);

    expect(
      filterAgentSessionsForDataPartition(sessions, partitions, "work").map(({ id }) => id),
    ).toEqual(["work-session"]);
    expect(
      filterAgentSessionsForDataPartition(sessions, partitions, "default").map(({ id }) => id),
    ).toEqual(["default-session"]);
    expect(sessionMatchesDataPartition(sessions[0], partitions, "work")).toBe(true);
  });
});
