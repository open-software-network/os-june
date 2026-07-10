export const DATE_FORMAT_STORAGE_KEY = "june:date-format";
export const DATE_FORMAT_CHANGED_EVENT = "june:date-format-changed";

export type DateFormatPreference = "system" | "month-first" | "day-first";

export type DateFormatChangedDetail = {
  preference: DateFormatPreference;
};

export function getStoredDateFormat(): DateFormatPreference {
  if (typeof window === "undefined") return "system";
  try {
    return normalizeDateFormatPreference(window.localStorage.getItem(DATE_FORMAT_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function setStoredDateFormat(preference: DateFormatPreference) {
  try {
    window.localStorage.setItem(DATE_FORMAT_STORAGE_KEY, preference);
  } catch {
    // Locked-down WebViews may reject storage writes. Keep the live choice.
  }
  window.dispatchEvent(
    new CustomEvent<DateFormatChangedDetail>(DATE_FORMAT_CHANGED_EVENT, {
      detail: { preference },
    }),
  );
}

export function formatCalendarDate(
  date: Date,
  preference: DateFormatPreference,
  locales?: Intl.LocalesArgument,
) {
  const normalizedPreference = normalizeDateFormatPreference(preference);
  const formatter = new Intl.DateTimeFormat(locales, {
    month: "short",
    day: "numeric",
  });
  if (normalizedPreference === "system") return formatter.format(date);

  // Format each component on its own so locale-specific units stay attached
  // when their order is forced (for example, Japanese `7月` and `9日`).
  const month = new Intl.DateTimeFormat(locales, { month: "short" }).format(date);
  const day = new Intl.DateTimeFormat(locales, { day: "numeric" }).format(date);
  return normalizedPreference === "month-first" ? `${month} ${day}` : `${day} ${month}`;
}

export function normalizeDateFormatPreference(value: unknown): DateFormatPreference {
  if (value === "month-first" || value === "day-first") return value;
  return "system";
}
