import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  SkillsHubController,
  allowsForceOverride,
  buildSkillInstallReview,
  parseHubSkillResult,
  parseSkillScan,
  requiresInstallReview,
  reviewLogRecord,
  skillInstallVerdict,
  verdictMeta,
  type HermesHubSkillResult,
  type SkillsHubEngine,
} from "../lib/hermes-admin";
import { SkillInstallReviewDialog } from "../components/settings/SkillInstallReviewDialog";
import {
  instantSleep,
  makeAdminHarness,
} from "./fixtures/hermes-admin-harness";
import { skillScanStatesScenario } from "./fixtures/hermes-admin-scenarios";

function hub(raw: Record<string, unknown>): HermesHubSkillResult {
  const result = parseHubSkillResult(raw);
  if (!result) throw new Error("fixture did not parse");
  return result;
}

// A bearer header value an exfiltration finding might quote verbatim. The
// review log scrubber masks the token while preserving the finding text.
const FAKE_BEARER = "Bearer FAKE-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ---------------------------------------------------------------------------
// Scan parsing: verdict, findings, files, capabilities, bundle — defensively.
// ---------------------------------------------------------------------------

describe("skill install review — scan parsing", () => {
  it("returns undefined when nothing scan-shaped is present", () => {
    expect(parseSkillScan({ identifier: "x" })).toBeUndefined();
  });

  it("normalizes verdict synonyms", () => {
    expect(parseSkillScan({ scan: { verdict: "blocked" } })?.verdict).toBe(
      "dangerous",
    );
    expect(parseSkillScan({ scan: { verdict: "warn" } })?.verdict).toBe(
      "caution",
    );
    expect(parseSkillScan({ security: { result: "clean" } })?.verdict).toBe(
      "trusted",
    );
    expect(parseSkillScan({ scan: { findings: [] } })?.verdict).toBe("unknown");
  });

  it("reads findings, files, capabilities, and bundle from a rich scan", () => {
    const scan = parseSkillScan({
      scan: {
        verdict: "caution",
        overridable: true,
        summary: "Runs scripts",
        findings: [
          { category: "Network", severity: "warn", detail: "Posts data" },
          "A bare string finding",
        ],
        affected_files: ["a/SKILL.md", "a/scripts/run.py"],
        capabilities: ["network", "shell"],
        bundle: { has_scripts: true, scripts: 2, references: 1 },
      },
    });
    expect(scan?.findings).toHaveLength(2);
    expect(scan?.findings?.[0].severity).toBe("warn");
    expect(scan?.findings?.[1].detail).toBe("A bare string finding");
    expect(scan?.affectedFiles).toEqual(["a/SKILL.md", "a/scripts/run.py"]);
    expect(scan?.capabilities).toEqual(["network", "shell"]);
    expect(scan?.bundle?.scriptCount).toBe(2);
    expect(scan?.overridable).toBe(true);
  });

  it("attaches the scan to a parsed hub result", () => {
    const r = hub({ identifier: "x", scan: { verdict: "dangerous" } });
    expect(r.scan?.verdict).toBe("dangerous");
  });
});

// ---------------------------------------------------------------------------
// Verdict mapping + gating: the four UI states and the override rule.
// ---------------------------------------------------------------------------

describe("skill install review — verdict + gating", () => {
  const scenario = skillScanStatesScenario().hubResults!;
  const results = scenario.map((raw) =>
    hub(raw as unknown as Record<string, unknown>),
  );
  const [trusted, caution, dangerous, unknown] = results;

  it("maps each scan state to the right verdict", () => {
    expect(skillInstallVerdict(trusted)).toBe("trusted");
    expect(skillInstallVerdict(caution)).toBe("caution");
    expect(skillInstallVerdict(dangerous)).toBe("dangerous");
    expect(skillInstallVerdict(unknown)).toBe("unknown");
  });

  it("only skips the review for a trusted install", () => {
    expect(requiresInstallReview(trusted)).toBe(false);
    expect(requiresInstallReview(caution)).toBe(true);
    expect(requiresInstallReview(dangerous)).toBe(true);
    expect(requiresInstallReview(unknown)).toBe(true);
  });

  it("never allows a force override for a dangerous verdict", () => {
    // The fixture marks the dangerous result overridable: true — June ignores it.
    expect(dangerous.scan?.overridable).toBe(true);
    expect(allowsForceOverride(dangerous)).toBe(false);
    expect(verdictMeta("dangerous").gate).toBe("blocked");
  });

  it("offers a force override for a caution verdict", () => {
    expect(allowsForceOverride(caution)).toBe(true);
  });

  it("honors an explicit overridable: false", () => {
    const r = hub({
      identifier: "x",
      trust: "community",
      scan: { verdict: "caution", overridable: false },
    });
    expect(allowsForceOverride(r)).toBe(false);
  });

  it("a dangerous scan wins over a high trust level", () => {
    const r = hub({
      identifier: "x",
      trust: "official",
      scan: { verdict: "dangerous" },
    });
    expect(skillInstallVerdict(r)).toBe("dangerous");
  });
});

// ---------------------------------------------------------------------------
// Review model + redacted debug log.
// ---------------------------------------------------------------------------

describe("skill install review — model + logging", () => {
  it("builds the full review model from a result", () => {
    const caution = hub(
      skillScanStatesScenario().hubResults![1] as unknown as Record<
        string,
        unknown
      >,
    );
    const review = buildSkillInstallReview(caution);
    expect(review.verdict.verdict).toBe("caution");
    expect(review.installable).toBe(true);
    expect(review.canForce).toBe(true);
    expect(review.requiresForce).toBe(true);
    expect(review.findings.length).toBeGreaterThan(0);
    expect(review.affectedFiles).toContain("scraper/scripts/run.py");
    expect(review.capabilities).toContain("shell");
    expect(review.bundle.some((b) => b.label === "Helper scripts")).toBe(true);
  });

  it("preserves findings in a redacted log record", () => {
    const review = buildSkillInstallReview(
      hub({
        identifier: "leaky",
        trust: "community",
        scan: {
          verdict: "caution",
          findings: [
            {
              category: "Secret leak",
              severity: "danger",
              // A secret embedded in a finding detail must be redacted.
              detail: `Sends header "${FAKE_BEARER}" to a remote host`,
            },
          ],
        },
      }),
    );
    const record = reviewLogRecord(review, "cancelled");
    const serialized = JSON.stringify(record);
    // Findings are preserved...
    expect(serialized).toContain("Secret leak");
    expect(record.decision).toBe("cancelled");
    // ...but the secret token is gone.
    expect(serialized).not.toContain("FAKE-aaaaaaaa");
  });
});

// ---------------------------------------------------------------------------
// Controller: force is never sent by default; sent only on an override decision.
// ---------------------------------------------------------------------------

function controllerFor() {
  const harness = makeAdminHarness(skillScanStatesScenario());
  const controller = new SkillsHubController(harness as SkillsHubEngine, {
    sleep: instantSleep,
  });
  return { harness, controller };
}

function installBody(harness: ReturnType<typeof makeAdminHarness>) {
  return harness.server.requestLog
    .filter((r) => r.path.includes("/api/skills/hub/install"))
    .map((r) => r.body as { identifier?: string; force?: boolean });
}

describe("skill install review — force wiring", () => {
  it("never sends force on a plain (no-decision) install", async () => {
    const { harness, controller } = controllerFor();
    await controller.search("pdf");
    const trusted = controller
      .getSnapshot()
      .results.find((r) => r.identifier === "official/pdf")!;
    await controller.install(trusted);
    const bodies = installBody(harness);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].force).toBeUndefined();
    controller.dispose();
  });

  it("sends force only when the decision explicitly returns it", async () => {
    const { harness, controller } = controllerFor();
    await controller.search("scraper");
    const caution = controller
      .getSnapshot()
      .results.find((r) => r.identifier === "skills.sh/scraper")!;
    await controller.install(caution, {
      confirm: () => ({ proceed: true, force: true }),
    });
    const bodies = installBody(harness);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].force).toBe(true);
    controller.dispose();
  });

  it("a proceed-without-force decision does not send force", async () => {
    const { harness, controller } = controllerFor();
    await controller.search("scraper");
    const caution = controller
      .getSnapshot()
      .results.find((r) => r.identifier === "skills.sh/scraper")!;
    await controller.install(caution, {
      confirm: () => ({ proceed: true, force: false }),
    });
    expect(installBody(harness)[0].force).toBeUndefined();
    controller.dispose();
  });

  it("a declined decision sends no install request", async () => {
    const { harness, controller } = controllerFor();
    await controller.search("scraper");
    const caution = controller
      .getSnapshot()
      .results.find((r) => r.identifier === "skills.sh/scraper")!;
    await controller.install(caution, { confirm: () => ({ proceed: false }) });
    expect(installBody(harness)).toHaveLength(0);
    expect(
      controller.getSnapshot().installs.get("skills.sh/scraper")?.phase,
    ).toBe("idle");
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Dialog rendering: findings, force gating, dangerous-no-override.
// ---------------------------------------------------------------------------

function reviewFor(index: number) {
  const raw = skillScanStatesScenario().hubResults![index] as unknown as Record<
    string,
    unknown
  >;
  return buildSkillInstallReview(hub(raw));
}

describe("skill install review — dialog", () => {
  it("requires the acknowledgement before a force install for a caution skill", () => {
    const onDecide = vi.fn();
    render(
      <SkillInstallReviewDialog
        review={reviewFor(1)}
        mode="sandboxed"
        onDecide={onDecide}
      />,
    );
    const dialog = screen.getByRole("dialog");
    // Findings + affected files + capabilities are surfaced.
    expect(within(dialog).getByText("Network access")).toBeInTheDocument();
    expect(
      within(dialog).getByText("scraper/scripts/run.py"),
    ).toBeInTheDocument();
    // The install button is disabled until the box is ticked.
    const install = within(dialog).getByRole("button", {
      name: /install anyway/i,
    });
    expect(install).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    expect(install).toBeEnabled();
    fireEvent.click(install);
    expect(onDecide).toHaveBeenCalledWith({ proceed: true, force: true });
  });

  it("blocks a dangerous skill with no override path", () => {
    const onDecide = vi.fn();
    render(
      <SkillInstallReviewDialog
        review={reviewFor(2)}
        mode="sandboxed"
        onDecide={onDecide}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Data exfiltration")).toBeInTheDocument();
    // No install/override button at all — only cancel.
    expect(
      within(dialog).queryByRole("button", { name: /install/i }),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /cancel/i }),
    ).toBeInTheDocument();
  });

  it("shows the sandbox/full-mode runtime note for bundled scripts", () => {
    render(
      <SkillInstallReviewDialog
        review={reviewFor(1)}
        mode="unrestricted"
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText(/Full mode runtime/i)).toBeInTheDocument();
  });

  it("cancel resolves a non-proceed decision", () => {
    const onDecide = vi.fn();
    render(
      <SkillInstallReviewDialog
        review={reviewFor(3)}
        mode="sandboxed"
        onDecide={onDecide}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onDecide).toHaveBeenCalledWith({ proceed: false, force: false });
  });

  it("installs an unscanned direct-URL skill after a plain confirmation (no force)", () => {
    const onDecide = vi.fn();
    const review = reviewFor(3);
    expect(review.requiresForce).toBe(false);
    render(
      <SkillInstallReviewDialog
        review={review}
        mode="sandboxed"
        onDecide={onDecide}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^install$/i }));
    expect(onDecide).toHaveBeenCalledWith({ proceed: true, force: false });
  });
});
