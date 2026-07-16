export function parseAllowedUserIds(raw: string): ReadonlySet<string> {
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => /^usr_[A-Za-z0-9_-]+$/.test(value)),
  );
}

export function isAllowedUser(userId: string, allowedUserIds: ReadonlySet<string>): boolean {
  return allowedUserIds.has(userId);
}
