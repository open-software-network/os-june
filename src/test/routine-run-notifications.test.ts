import { beforeEach, describe, expect, it } from "vitest";
import {
  createSingleFlight,
  loadRoutineRunWatchState,
  markRunsNotified,
  routineRunFreshnessTimestamp,
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
    message_count: 4,
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

  it("notifies once for a freshly ended run and never again after delivery", () => {
    const first = routineRunWatchStep(PRIMED, [run("cron_job1_20260720_115000")], NOW);
    expect(first.notices).toHaveLength(1);
    expect(first.notices[0]).toMatchObject({
      sessionId: "cron_job1_20260720_115000",
      jobId: "job1",
      title: "Morning brief",
      body: "Here is your brief.",
    });

    const afterDelivery = markRunsNotified(first.next, ["cron_job1_20260720_115000"]);
    const second = routineRunWatchStep(afterDelivery, [run("cron_job1_20260720_115000")], NOW);
    expect(second.notices).toEqual([]);
  });

  it("retries a run whose notification delivery failed", () => {
    const first = routineRunWatchStep(PRIMED, [run("cron_job1_20260720_115000")], NOW);
    expect(first.notices).toHaveLength(1);

    // Delivery failed: the id was never marked, so the next tick re-notices.
    const second = routineRunWatchStep(first.next, [run("cron_job1_20260720_115000")], NOW);
    expect(second.notices).toHaveLength(1);
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

  it("does not treat a stuck zero-message session as finished", () => {
    // Cron sessions persist before their first message; an inactive
    // zero-message row with no end marker is stuck, not done.
    const { notices } = routineRunWatchStep(
      PRIMED,
      [
        run("cron_job1_20260720_115000", {
          message_count: 0,
          ended_at: null,
          end_reason: null,
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
    const stepped = routineRunWatchStep(state, [run("cron_job1_20260720_115000")], NOW);
    const next = markRunsNotified(stepped.next, ["cron_job1_20260720_115000"]);
    expect(next.seen.has("cron_gone_20260101_000000")).toBe(false);
    expect(next.seen.has("cron_job1_20260720_115000")).toBe(true);
  });
});

describe("routineRunFreshnessTimestamp", () => {
  it("prefers ended_at over an older last_active for long-running routines", () => {
    const timestamp = routineRunFreshnessTimestamp(
      run("cron_job1_20260720_100000", {
        last_active: "2026-07-20T10:05:00Z",
        ended_at: "2026-07-20T11:55:00Z",
      }),
    );
    expect(timestamp).toBe(Date.parse("2026-07-20T11:55:00Z"));
  });

  it("accepts endedAt camelCase and falls back to sessionTimestamp when no end time exists", () => {
    expect(
      routineRunFreshnessTimestamp(
        run("cron_job1_20260720_115000", {
          ended_at: null,
          endedAt: "2026-07-20T11:50:00Z",
          last_active: "2026-07-20T11:40:00Z",
        }),
      ),
    ).toBe(Date.parse("2026-07-20T11:50:00Z"));

    expect(
      routineRunFreshnessTimestamp(
        run("cron_job1_20260720_115000", {
          ended_at: null,
          endedAt: null,
          last_active: "2026-07-20T11:40:00Z",
        }),
      ),
    ).toBe(Date.parse("2026-07-20T11:40:00Z"));
  });
});

describe("routineRunWatchStep freshness", () => {
  it("notifies a just-ended long-running routine even when last_active is old", () => {
    const { notices } = routineRunWatchStep(
      PRIMED,
      [
        run("cron_job1_20260720_100000", {
          last_active: "2026-07-20T10:05:00Z",
          ended_at: "2026-07-20T11:55:00Z",
        }),
      ],
      NOW,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.sessionId).toBe("cron_job1_20260720_100000");
  });
});

describe("createSingleFlight", () => {
  it("skips overlapping work while one flight is in progress", async () => {
    const runSingleFlight = createSingleFlight();
    let resolveFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let firstStarted = 0;
    let secondStarted = 0;

    const first = runSingleFlight(async () => {
      firstStarted += 1;
      await firstDone;
    });
    const second = runSingleFlight(async () => {
      secondStarted += 1;
    });

    await expect(second).resolves.toBe(false);
    resolveFirst();
    await expect(first).resolves.toBe(true);
    expect(firstStarted).toBe(1);
    expect(secondStarted).toBe(0);

    await expect(
      runSingleFlight(async () => {
        secondStarted += 1;
      }),
    ).resolves.toBe(true);
    expect(secondStarted).toBe(1);
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
