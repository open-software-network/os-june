/**
 * Pure, render-free view logic for the skill install security review (spec 07).
 * Given a {@link HermesHubSkillResult} (and the install-time scan Hermes attaches
 * to it or to its install response), this decides:
 *
 * - the install verdict June acts on (trusted / caution / dangerous / unknown),
 *   combining the hub trust level, the direct-URL signal, and Hermes' scan;
 * - whether an install must route through the security review at all;
 * - whether a `force` override is even offered (a dangerous verdict NEVER is);
 * - the review screen's content: source + trust, install identifier, upstream
 *   URLs, what the skill bundles, the agent capabilities it may use, the exact
 *   affected files, and the summarized findings;
 * - a redacted record for the debug log, so findings are preserved without
 *   leaking any secret-shaped text.
 *
 * Kept separate from the React dialog and the data hook so the trust model is
 * unit-testable without rendering. Copy is sentence case, no em/en-dashes, per
 * June conventions. This module NEVER talks to the network and NEVER decides to
 * send `force` on its own; it only describes what the UI should require.
 */

import { redactBodyPreview, redactForLog } from "./redact";
import type {
  HermesHubSkillResult,
  HermesSkillBundle,
  HermesSkillScan,
  HermesSkillScanFinding,
  HermesSkillScanVerdict,
} from "./schemas";
import {
  isDirectUrlInstall,
  sourceKindFor,
  sourceKindMeta,
} from "./hub-search-view";

/** The shared copy line the review surfaces, explaining the trust model. */
export const SKILL_TRUST_MODEL_COPY =
  "Skills are instructions and helper files the agent may load during tasks. Review community skills before installing them.";

/** How the install should be gated, derived from the verdict. */
export type SkillInstallGate =
  /** Install immediately, no review screen (official/bundled/trusted). */
  | "allow"
  /** Show the review; install may continue after explicit confirmation. */
  | "review"
  /** Show the review; install is blocked and offers no override. */
  | "blocked";

/** Display metadata for a verdict. */
export type VerdictMeta = {
  verdict: HermesSkillScanVerdict;
  /** Short label, sentence case. */
  label: string;
  /** Tone the UI styles the review header with. */
  tone: "trusted" | "caution" | "danger" | "neutral";
  /** One-line headline for the review screen. */
  headline: string;
  /** How the install is gated for this verdict. */
  gate: SkillInstallGate;
};

const VERDICT_META: Readonly<Record<HermesSkillScanVerdict, VerdictMeta>> =
  Object.freeze({
    trusted: {
      verdict: "trusted",
      label: "Trusted",
      tone: "trusted",
      headline: "This skill is from a trusted source.",
      gate: "allow",
    },
    caution: {
      verdict: "caution",
      label: "Review before installing",
      tone: "caution",
      headline: "Review this community skill before installing it.",
      gate: "review",
    },
    dangerous: {
      verdict: "dangerous",
      label: "Blocked",
      tone: "danger",
      headline: "Hermes blocked this skill. It cannot be installed from June.",
      gate: "blocked",
    },
    unknown: {
      verdict: "unknown",
      label: "Unverified",
      tone: "neutral",
      headline:
        "This skill has not been verified. Review it before installing.",
      gate: "review",
    },
  });

/** The display metadata for a verdict. */
export function verdictMeta(verdict: HermesSkillScanVerdict): VerdictMeta {
  return VERDICT_META[verdict];
}

/**
 * Derives the verdict June acts on for a result, combining Hermes' scan (the
 * authority when present) with the hub trust level and the direct-URL signal.
 *
 * Precedence:
 * - a `dangerous` scan always wins (never softened);
 * - otherwise the scan verdict, when present, is used;
 * - with no scan, an official/verified result is `trusted`, a direct-URL install
 *   is `unknown` (lowest trust, needs an advanced opt-in), a community result is
 *   `caution`, and an unverified result is `unknown`.
 */
export function skillInstallVerdict(
  result: HermesHubSkillResult,
): HermesSkillScanVerdict {
  const scan = result.scan;
  if (scan?.verdict === "dangerous") return "dangerous";
  if (scan && scan.verdict !== "unknown") return scan.verdict;
  // No conclusive scan: fall back to the trust level + source shape.
  if (result.trust === "official" || result.trust === "verified") {
    return "trusted";
  }
  if (isDirectUrlInstall(result)) return "unknown";
  if (result.trust === "community") return "caution";
  return "unknown";
}

/** Whether an install needs the security review screen before it can proceed.
 * Trusted installs skip it; everything else routes through it. */
export function requiresInstallReview(result: HermesHubSkillResult): boolean {
  return verdictMeta(skillInstallVerdict(result)).gate !== "allow";
}

/**
 * Whether a `force` override may be offered for this result. A `dangerous`
 * verdict is NEVER overridable from June, regardless of what the scan reports.
 * For other gated verdicts, an override is offered (Hermes can still refuse it
 * server-side); when the scan explicitly reports `overridable: false` we honor
 * that and do not offer one.
 */
export function allowsForceOverride(result: HermesHubSkillResult): boolean {
  const meta = verdictMeta(skillInstallVerdict(result));
  if (meta.gate === "blocked") return false;
  if (meta.gate === "allow") return false;
  if (result.scan?.overridable === false) return false;
  return true;
}

/** A normalized bundle summary for display: the count lines a skill ships. An
 * empty array means "nothing reported", which the UI shows as unknown contents
 * rather than "ships nothing". */
export type BundleLine = { label: string; detail: string };

export function bundleLines(
  bundle: HermesSkillBundle | undefined,
): BundleLine[] {
  if (!bundle) return [];
  const lines: BundleLine[] = [];
  const scripts = bundle.scriptCount;
  if (bundle.hasScripts || (scripts !== undefined && scripts > 0)) {
    lines.push({
      label: "Helper scripts",
      detail:
        scripts !== undefined
          ? `${scripts} ${plural(scripts, "script", "scripts")} the agent can run`
          : "Runs in the selected runtime when the agent uses the skill",
    });
  }
  pushCount(lines, "Templates", bundle.templateCount);
  pushCount(lines, "References", bundle.referenceCount);
  pushCount(lines, "Other assets", bundle.assetCount);
  return lines;
}

function pushCount(
  lines: BundleLine[],
  label: string,
  count: number | undefined,
): void {
  if (count === undefined || count <= 0) return;
  lines.push({ label, detail: `${count} ${plural(count, "file", "files")}` });
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** A finding's severity tone for styling. */
export function findingTone(
  finding: HermesSkillScanFinding,
): "danger" | "caution" | "neutral" {
  if (finding.severity === "danger") return "danger";
  if (finding.severity === "warn") return "caution";
  return "neutral";
}

/** The fully-resolved review model the dialog renders. A pure projection of the
 * result + its scan; the dialog adds no trust logic of its own. */
export type SkillInstallReview = {
  identifier: string;
  name: string;
  /** The friendly source label (e.g. "Official", "Direct URL"). */
  sourceLabel: string;
  /** The hub trust level, for the trust badge. */
  trust: HermesHubSkillResult["trust"];
  verdict: VerdictMeta;
  /** True when this is a single-file direct-URL install. */
  directUrl: boolean;
  /** Whether the install can proceed at all (false for a blocked verdict). */
  installable: boolean;
  /** Whether a `force` override is offered (requires explicit confirmation). */
  canForce: boolean;
  /** Whether confirming requires sending `force` (a gated, scanned install). */
  requiresForce: boolean;
  summary?: string;
  findings: HermesSkillScanFinding[];
  affectedFiles: string[];
  capabilities: string[];
  bundle: BundleLine[];
  upstreamUrls: string[];
};

/** Builds the review model for a result. Combines the result's scan with the
 * derived verdict; never mutates the input. */
export function buildSkillInstallReview(
  result: HermesHubSkillResult,
  /** A richer scan from the install response, when one came back (e.g. a block).
   * It takes precedence over the search-result scan. */
  installScan?: HermesSkillScan,
): SkillInstallReview {
  const merged: HermesHubSkillResult = installScan
    ? { ...result, scan: installScan }
    : result;
  const verdict = verdictMeta(skillInstallVerdict(merged));
  const scan = merged.scan;
  const installable = verdict.gate !== "blocked";
  const canForce = allowsForceOverride(merged);
  // A scanned, gated verdict needs `force` to override; a plain low-trust
  // direct-URL install (no conclusive scan) just needs confirmation, not force.
  const requiresForce =
    installable && Boolean(scan) && verdict.gate !== "allow";
  return {
    identifier: merged.identifier,
    name: merged.name || merged.identifier,
    sourceLabel: sourceKindMeta(sourceKindFor(merged)).label,
    trust: merged.trust,
    verdict,
    directUrl: isDirectUrlInstall(merged),
    installable,
    canForce,
    requiresForce,
    summary: scan?.summary,
    findings: scan?.findings ?? [],
    affectedFiles: scan?.affectedFiles ?? [],
    capabilities: scan?.capabilities ?? [],
    bundle: bundleLines(scan?.bundle),
    upstreamUrls: merged.upstreamUrls ?? [],
  };
}

/**
 * A redacted, log-safe record of a review decision, for the debug log. The spec
 * requires findings to be PRESERVED in debug logs with secrets REDACTED. Free
 * text (a finding detail, the summary) can carry a credential inline, which the
 * structural sanitizer alone misses, so each such string is ALSO run through the
 * token/bearer scrubber. Never returns a raw secret; the caller decides
 * whether/where to log it.
 */
export function reviewLogRecord(
  review: SkillInstallReview,
  decision: "installed" | "forced" | "cancelled" | "blocked",
): Record<string, unknown> {
  return redactForLog({
    scope: "skill-install-review",
    decision,
    identifier: review.identifier,
    verdict: review.verdict.verdict,
    source: review.sourceLabel,
    trust: review.trust,
    summary: review.summary ? redactBodyPreview(review.summary) : undefined,
    findings: review.findings.map((finding) => ({
      category: finding.category,
      severity: finding.severity,
      detail: redactBodyPreview(finding.detail),
    })),
    affectedFiles: review.affectedFiles,
    capabilities: review.capabilities,
  }) as Record<string, unknown>;
}
