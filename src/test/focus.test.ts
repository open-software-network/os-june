import { describe, expect, it } from "vitest";
import {
  buildFocusIntervalPlan,
  focusClock,
  focusPlanMinutes,
  focusProjectAllocations,
  formatFocusDuration,
  midpointTimestamp,
} from "../lib/focus";
import type { FocusSessionDto } from "../lib/tauri";

function session(status: FocusSessionDto["status"]): FocusSessionDto {
  return {
    id: "focus-1",
    intention: "Ship the release",
    status,
    currentIntervalPosition: 0,
    createdAt: "2027-01-15T00:00:00.000Z",
    intervals: [],
    segments: [],
    plannedFocusMs: 60_000,
    actualFocusMs: 10_000,
    actualBreakMs: 0,
    pausedMs: 0,
    currentElapsedMs: 10_000,
    remainingMs: 50_000,
    overtimeMs: 4_000,
    outcome: "active",
  };
}

describe("Focus display helpers", () => {
  it("advances running countdowns without changing paused snapshots", () => {
    expect(focusClock(session("focusing"), 1_000, 6_000)).toEqual({
      valueMs: 45_000,
      direction: "down",
    });
    expect(focusClock(session("paused"), 1_000, 6_000)).toEqual({
      valueMs: 50_000,
      direction: "down",
    });
    expect(focusClock(session("onBreak"), 1_000, 6_000)).toEqual({
      valueMs: 45_000,
      direction: "down",
    });
    expect(focusClock(session("completed"), 1_000, 6_000)).toEqual({
      valueMs: 50_000,
      direction: "down",
    });
  });

  it("counts overtime upward", () => {
    const overtime = session("overtime");
    overtime.intervals = [{ position: 0, kind: "focus", plannedDurationMs: 6_000 }];
    overtime.overtimeMs = 20_000;
    expect(focusClock(overtime, 1_000, 6_000)).toEqual({
      valueMs: 9_000,
      direction: "up",
    });
    overtime.status = "paused";
    overtime.pausedFrom = "overtime";
    expect(focusClock(overtime, 1_000, 6_000)).toEqual({
      valueMs: 4_000,
      direction: "up",
    });
  });

  it("formats durations and finds a strict segment midpoint", () => {
    expect(formatFocusDuration(3_661_000)).toBe("1:01:01");
    expect(midpointTimestamp("2027-01-15T00:00:00.000Z", "2027-01-15T00:00:40.000Z")).toBe(
      "2027-01-15T00:00:20.000Z",
    );
  });

  it("builds a four-by-25 plan across three Projects", () => {
    const plan = buildFocusIntervalPlan({
      intervalCount: 4,
      focusMinutes: 25,
      shortBreakMinutes: 5,
      longBreakMinutes: 15,
      projectIds: ["project-1", "project-2", "project-3", "project-1"],
    });

    expect(plan).toHaveLength(7);
    expect(plan.filter((interval) => interval.kind === "focus")).toEqual([
      { kind: "focus", durationMinutes: 25, projectId: "project-1" },
      { kind: "focus", durationMinutes: 25, projectId: "project-2" },
      { kind: "focus", durationMinutes: 25, projectId: "project-3" },
      { kind: "focus", durationMinutes: 25, projectId: "project-1" },
    ]);
    expect(focusPlanMinutes(plan)).toBe(115);
  });

  it("uses the long break after every fourth focus interval", () => {
    const plan = buildFocusIntervalPlan({
      intervalCount: 5,
      focusMinutes: 40,
      shortBreakMinutes: 5,
      longBreakMinutes: 20,
      projectIds: [],
    });

    expect(
      plan.filter((interval) => interval.kind === "break").map((item) => item.durationMinutes),
    ).toEqual([5, 5, 5, 20]);
  });

  it("reports planned and corrected actual time by Project", () => {
    const value = session("completed");
    value.intervals = [
      {
        position: 0,
        kind: "focus",
        plannedDurationMs: 25_000,
        projectId: "project-1",
        projectName: "Launch",
      },
      { position: 1, kind: "break", plannedDurationMs: 5_000 },
      {
        position: 2,
        kind: "focus",
        plannedDurationMs: 25_000,
        projectId: "project-2",
        projectName: "Support",
      },
    ];
    value.segments = [
      {
        id: "segment-1",
        intervalPosition: 0,
        kind: "focus",
        startedAt: "2027-01-15T00:00:00.000Z",
        endedAt: "2027-01-15T00:00:10.000Z",
        durationMs: 10_000,
        projectId: "project-1",
        projectName: "Launch",
      },
      {
        id: "segment-2",
        intervalPosition: 0,
        kind: "focus",
        startedAt: "2027-01-15T00:00:10.000Z",
        endedAt: "2027-01-15T00:00:25.000Z",
        durationMs: 15_000,
        projectId: "project-3",
        projectName: "Release",
      },
    ];

    expect(focusProjectAllocations(value)).toEqual([
      {
        key: "project-1",
        projectId: "project-1",
        projectName: "Launch",
        plannedMs: 25_000,
        actualMs: 10_000,
      },
      {
        key: "project-2",
        projectId: "project-2",
        projectName: "Support",
        plannedMs: 25_000,
        actualMs: 0,
      },
      {
        key: "project-3",
        projectId: "project-3",
        projectName: "Release",
        plannedMs: 0,
        actualMs: 15_000,
      },
    ]);
  });
});
