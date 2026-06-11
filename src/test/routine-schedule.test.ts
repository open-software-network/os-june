import { describe, expect, it } from "vitest";
import { humanizeSchedule } from "../lib/routine-schedule";

/** Mirrors the formatter's locale-aware clock rendering so assertions hold
 * regardless of the machine locale running the suite. */
function time(hour: number, minute: number) {
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

describe("humanizeSchedule", () => {
  it("translates daily schedules", () => {
    expect(humanizeSchedule("0 8 * * *")).toBe(`Every day at ${time(8, 0)}`);
    expect(humanizeSchedule("30 17 * * *")).toBe(
      `Every day at ${time(17, 30)}`,
    );
    expect(humanizeSchedule("0 9,17 * * *")).toBe(
      `Every day at ${time(9, 0)} and ${time(17, 0)}`,
    );
  });

  it("translates minute and hour cadences", () => {
    expect(humanizeSchedule("* * * * *")).toBe("Every minute");
    expect(humanizeSchedule("*/15 * * * *")).toBe("Every 15 minutes");
    expect(humanizeSchedule("*/1 * * * *")).toBe("Every minute");
    expect(humanizeSchedule("0 * * * *")).toBe("Every hour");
    expect(humanizeSchedule("30 * * * *")).toBe("Every hour at :30");
    expect(humanizeSchedule("0 */2 * * *")).toBe("Every 2 hours");
  });

  it("translates day-of-week schedules", () => {
    expect(humanizeSchedule("0 9 * * 1-5")).toBe(`Weekdays at ${time(9, 0)}`);
    expect(humanizeSchedule("0 10 * * 0,6")).toBe(`Weekends at ${time(10, 0)}`);
    expect(humanizeSchedule("0 8 * * 1")).toBe(`Every Monday at ${time(8, 0)}`);
    expect(humanizeSchedule("0 8 * * mon")).toBe(
      `Every Monday at ${time(8, 0)}`,
    );
    // Cron allows 7 for Sunday alongside 0.
    expect(humanizeSchedule("0 8 * * 7")).toBe(`Every Sunday at ${time(8, 0)}`);
    expect(humanizeSchedule("0 8 * * 1,3,5")).toBe(
      `Every Monday, Wednesday, and Friday at ${time(8, 0)}`,
    );
    expect(humanizeSchedule("0 8 * * 1-3")).toBe(
      `Every Monday to Wednesday at ${time(8, 0)}`,
    );
    expect(humanizeSchedule("0 8 * * 0-6")).toBe(`Every day at ${time(8, 0)}`);
  });

  it("translates monthly and yearly schedules", () => {
    expect(humanizeSchedule("0 9 1 * *")).toBe(
      `Monthly on the 1st at ${time(9, 0)}`,
    );
    expect(humanizeSchedule("0 9 1,15 * *")).toBe(
      `Monthly on the 1st and 15th at ${time(9, 0)}`,
    );
    expect(humanizeSchedule("0 9 22 * *")).toBe(
      `Monthly on the 22nd at ${time(9, 0)}`,
    );
    expect(humanizeSchedule("0 9 11 6 *")).toBe(
      `Every year on Jun 11 at ${time(9, 0)}`,
    );
    expect(humanizeSchedule("0 9 11 jun *")).toBe(
      `Every year on Jun 11 at ${time(9, 0)}`,
    );
  });

  it("translates macros", () => {
    expect(humanizeSchedule("@hourly")).toBe("Every hour");
    expect(humanizeSchedule("@daily")).toBe(`Every day at ${time(0, 0)}`);
    expect(humanizeSchedule("@weekly")).toBe(`Every Sunday at ${time(0, 0)}`);
    expect(humanizeSchedule("@monthly")).toBe(
      `Monthly on the 1st at ${time(0, 0)}`,
    );
    expect(humanizeSchedule("@yearly")).toBe(
      `Every year on Jan 1 at ${time(0, 0)}`,
    );
  });

  it("accepts a cron: prefix", () => {
    expect(humanizeSchedule("cron: 0 8 * * *")).toBe(
      `Every day at ${time(8, 0)}`,
    );
  });

  it("passes non-cron schedules through unchanged", () => {
    expect(humanizeSchedule("every day at 9:00")).toBe("every day at 9:00");
    expect(humanizeSchedule("every 30m")).toBe("every 30m");
    expect(humanizeSchedule("2026-06-12T09:00:00")).toBe("2026-06-12T09:00:00");
    expect(humanizeSchedule("")).toBe("");
  });

  it("passes invalid or exotic cron expressions through unchanged", () => {
    // Out-of-range minute.
    expect(humanizeSchedule("61 9 * * *")).toBe("61 9 * * *");
    // Six fields (seconds-style cron) is not the gateway's format.
    expect(humanizeSchedule("0 0 9 * * *")).toBe("0 0 9 * * *");
    // Stepped range: too exotic to phrase confidently.
    expect(humanizeSchedule("1-5/2 * * * *")).toBe("1-5/2 * * * *");
    // Day-of-month and day-of-week combined use cron's OR semantics; saying
    // it wrongly is worse than showing the expression.
    expect(humanizeSchedule("0 9 1 * 1")).toBe("0 9 1 * 1");
    expect(humanizeSchedule("*/0 * * * *")).toBe("*/0 * * * *");
  });
});
