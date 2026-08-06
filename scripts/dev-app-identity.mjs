const ISOLATED_DEV_NAMESPACES = new Set(["codex", "claude"]);

export function devAppIdentityForBranch(
  branchName,
  { baseName = "Clovy", baseIdentifier = "co.opensoftware.june" } = {},
) {
  const normalized = `${branchName ?? ""}`.trim();
  const namespace = normalized.split("/", 1)[0]?.toLowerCase();
  const issueMatch = normalized.match(/\bjun-(\d+)\b/i);

  if (!ISOLATED_DEV_NAMESPACES.has(namespace) || !issueMatch) {
    return { productName: baseName, identifier: baseIdentifier };
  }

  const issueNumber = issueMatch[1];
  return {
    productName: baseName,
    identifier: `${baseIdentifier}.${namespace}.jun${issueNumber}`,
  };
}
