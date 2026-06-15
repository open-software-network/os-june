import { describe, expect, it } from "vitest";
import {
  isReportCategory,
  matchReportCategories,
  reportCategoryDef,
  REPORT_CATEGORIES,
} from "../components/agent/composer/reportCategory";

describe("report category model", () => {
  it("exposes exactly the three categories in canonical order", () => {
    expect(REPORT_CATEGORIES.map((c) => c.key)).toEqual([
      "bug",
      "feedback",
      "feature",
    ]);
  });

  it("looks up a category by key and rejects unknowns", () => {
    expect(reportCategoryDef("bug")?.label).toBe("Bug report");
    expect(reportCategoryDef("nope")).toBeUndefined();
    expect(reportCategoryDef(null)).toBeUndefined();
  });

  it("guards arbitrary values as categories", () => {
    expect(isReportCategory("feature")).toBe(true);
    expect(isReportCategory("issue-report")).toBe(false);
    expect(isReportCategory(undefined)).toBe(false);
  });

  it("keeps the full palette for an empty query", () => {
    expect(matchReportCategories("")).toHaveLength(3);
    expect(matchReportCategories("   ")).toHaveLength(3);
  });

  it("matches on label, key, and keywords", () => {
    expect(matchReportCategories("bug").map((c) => c.key)).toEqual(["bug"]);
    // "report" is a bug keyword; "request" a feature keyword.
    expect(matchReportCategories("report").map((c) => c.key)).toEqual(["bug"]);
    expect(matchReportCategories("request").map((c) => c.key)).toEqual([
      "feature",
    ]);
    expect(matchReportCategories("feed").map((c) => c.key)).toEqual([
      "feedback",
    ]);
    expect(matchReportCategories("zzz")).toHaveLength(0);
  });
});
