import { beforeEach, describe, expect, it } from "vitest";
import {
  loadRoutineRunWatchState,
  routineRunWatchStep,
  saveRoutineRunWatchState,
  type RoutineRunWatchState,
} from "../lib/routine-run-notifications";
import type { HermesSessionInfo } from "../lib/tauri";

const NOW = Date.parse("2026-07-20T12:00:00Z");

function run(id: string, overrides: Partial<HermesSessionInfo> = {}): HermesSessionInfo {
  return {
    id,
    source: "cron",
    title: "Morning brief",
    preview: "Here is your brief.",
    ended_at: "2026-07-20T11:55:00Z",
    last_active: "2026-07-20T11:55:00Z",
    ...overrides,
  } as HermesSessionInfo;
}

const PRIMED: RoutineRunWatchState = { seen: new Set(), primed: true };

describe("routineRunWatchStep", () => {
  it("baselines existing runs silently on the first poll", () => {
    const { next, notices } = routineRunWatchStep(
      { seen: new Set(), primed: false },
      [run("cron_job1_20260720_115000")],
      NOW,
    );
    expect(notices).toEqual([]);
    expect(next.primed).toBe(true);
    expect(next.seen.has("cron_job1_20260720_115000")).toBe(true);
  });

  it("notifies once for a freshly ended run and never again", () => {
    const first = routineRunWatchStep(PRIMED, [run("cron_job1_20260720_115000")], NOW);
    expect(first.notices).toHaveLength(1);
    expect(first.notices[0]).toMatchObject({
      sessionId: "cron_job1_20260720_115000",
      jobId: "job1",
      title: "Morning brief",
      body: "Here is your brief.",
    });

    const second = routineRunWatchStep(first.next, [run("cron_job1_20260720_115000")], NOW);
    expect(second.notices).toEqual([]);
  });

  it("stays quiet for a run that is still going", () => {
    const { notices } = routineRunWatchStep(
      PRIMED,
      [run("cron_job1_20260720_115000", { active: true, ended_at: null, end_reason: null })],
      NOW,
    );
    expect(notices).toEqual([]);
  });

  it("treats stale ended runs as history, not news", () => {
    const { notices } = routineRunWatchStep(
      PRIMED,
      [
        run("cron_job1_20260719_080000", {
          ended_at: "2026-07-19T08:05:00Z",
          last_active: "2026-07-19T08:05:00Z",
        }),
      ],
      NOW,
    );
    expect(notices).toEqual([]);
  });

  it("ignores non-cron sessions entirely", () => {
    const { notices } = routineRunWatchStep(PRIMED, [run("user-session", { source: "user" })], NOW);
    expect(notices).toEqual([]);
  });

  it("falls back to generic copy when the run has no title or preview", () => {
    const { notices } = routineRunWatchStep(
      PRIMED,
      [run("cron_job1_20260720_115000", { title: "", preview: "" })],
      NOW,
    );
    expect(notices[0]).toMatchObject({
      title: "Routine finished",
      body: "Open June to read the result.",
    });
  });

  it("prunes ids that left the fetch window", () => {
    const state: RoutineRunWatchState = {
      seen: new Set(["cron_gone_20260101_000000"]),
      primed: true,
    };
    const { next } = routineRunWatchStep(state, [run("cron_job1_20260720_115000")], NOW);
    expect(next.seen.has("cron_gone_20260101_000000")).toBe(false);
    expect(next.seen.has("cron_job1_20260720_115000")).toBe(true);
  });
});

describe("watch state persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips through localStorage and marks reloads as primed", () => {
    expect(loadRoutineRunWatchState().primed).toBe(false);

    saveRoutineRunWatchState({ seen: new Set(["a", "b"]), primed: true });
    const loaded = loadRoutineRunWatchState();
    expect(loaded.primed).toBe(true);
    expect([...loaded.seen].sort()).toEqual(["a", "b"]);
  });

  it("recovers from corrupted storage", () => {
    window.localStorage.setItem("june.routineRuns.notified", "not json");
    expect(loadRoutineRunWatchState()).toEqual({ seen: new Set(), primed: false });
  });
});
