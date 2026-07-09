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

  const parts = formatter.formatToParts(date);
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!month || !day) return formatter.format(date);
  return normalizedPreference === "month-first" ? `${month} ${day}` : `${day} ${month}`;
}

export function normalizeDateFormatPreference(value: unknown): DateFormatPreference {
  if (value === "month-first" || value === "day-first") return value;
  return "system";
}
