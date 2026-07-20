const DEV_HARNESS_NAMES = new Map([
  ["codex", "Codex"],
  ["claude", "Claude"],
]);

export function devAppIdentityForBranch(
  branchName,
  { baseName = "June", baseIdentifier = "co.opensoftware.june" } = {},
) {
  const normalized = `${branchName ?? ""}`.trim();
  const namespace = normalized.split("/", 1)[0]?.toLowerCase();
  const harnessName = DEV_HARNESS_NAMES.get(namespace);
  const issueMatch = normalized.match(/\bjun-(\d+)\b/i);

  if (!harnessName || !issueMatch) {
    return { productName: baseName, identifier: baseIdentifier };
  }

  const issueNumber = issueMatch[1];
  const issueKey = `JUN-${issueNumber}`;
  return {
    productName: `${baseName} ${issueKey} ${harnessName}`,
    identifier: `${baseIdentifier}.${namespace}.jun${issueNumber}`,
  };
}
