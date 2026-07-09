import { beforeEach, describe, expect, it } from "vitest";
import {
  DATE_FORMAT_STORAGE_KEY,
  formatCalendarDate,
  getStoredDateFormat,
  setStoredDateFormat,
} from "../lib/date-format";

describe("date format preference", () => {
  beforeEach(() => localStorage.clear());

  it("defaults invalid stored values to the system format", () => {
    localStorage.setItem(DATE_FORMAT_STORAGE_KEY, "unknown");
    expect(getStoredDateFormat()).toBe("system");
  });

  it("persists a date order preference", () => {
    setStoredDateFormat("day-first");
    expect(getStoredDateFormat()).toBe("day-first");
  });

  it("formats month-first and day-first dates without changing the locale", () => {
    const date = new Date("2026-07-09T12:00:00Z");
    expect(formatCalendarDate(date, "month-first", "en-US")).toBe("Jul 9");
    expect(formatCalendarDate(date, "day-first", "en-US")).toBe("9 Jul");
  });
});
