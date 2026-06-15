/**
 * The three report categories a composer message can be tagged with. A tag is
 * an inline chip in the composer (see CategoryChip) — at most one per message.
 * The category drives two things: the preamble that frames the message for June
 * (see categoryPrompt in lib/issue-report-prompt.ts) and the no-charge signal carried
 * to the backend when the report is delivered.
 */

export type ReportCategory = "bug" | "feedback" | "feature";

export type ReportCategoryDef = {
  key: ReportCategory;
  /** Chip and menu label. Sentence case, no dashes (see CLAUDE.md). */
  label: string;
  /** Secondary line in the "/" menu. */
  hint: string;
  /** Extra terms the "/" filter matches beyond the label. */
  keywords: string[];
};

export const REPORT_CATEGORIES: ReportCategoryDef[] = [
  {
    key: "bug",
    label: "Bug report",
    hint: "Something isn't working right",
    keywords: ["bug", "issue", "report", "broken", "problem", "error", "crash"],
  },
  {
    key: "feedback",
    label: "Feedback",
    hint: "Share a thought with the team",
    keywords: ["feedback", "thoughts", "comment", "suggestion"],
  },
  {
    key: "feature",
    label: "Feature request",
    hint: "Ask for something new",
    keywords: ["feature", "request", "idea", "wish", "want"],
  },
];

const BY_KEY = new Map<ReportCategory, ReportCategoryDef>(
  REPORT_CATEGORIES.map((category) => [category.key, category]),
);

export function reportCategoryDef(
  key: ReportCategory | string | null | undefined,
): ReportCategoryDef | undefined {
  if (!key) return undefined;
  return BY_KEY.get(key as ReportCategory);
}

export function isReportCategory(value: unknown): value is ReportCategory {
  return typeof value === "string" && BY_KEY.has(value as ReportCategory);
}

/** Ranks categories against the text typed after "/". Empty query keeps the
 * canonical order so the menu opens as a stable three-item palette. */
export function matchReportCategories(query: string): ReportCategoryDef[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return REPORT_CATEGORIES;
  return REPORT_CATEGORIES.filter((category) => {
    if (category.label.toLowerCase().includes(trimmed)) return true;
    if (category.key.includes(trimmed)) return true;
    return category.keywords.some((keyword) => keyword.includes(trimmed));
  });
}
