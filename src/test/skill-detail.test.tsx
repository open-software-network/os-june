import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  diffSkillContent,
  parseSkill,
  readFrontmatterScalars,
  scanForSecrets,
  skillEditPolicy,
  skillSupportingFiles,
  splitSkillDocument,
  validateSkillContent,
  SkillDetailController,
  SKILL_MD_MAX_BYTES,
  type HermesSkillInfo,
  type SkillDetailEngine,
  type SkillDetailState,
} from "../lib/hermes-admin";
import { SkillDetailView } from "../components/settings/SkillDetailSection";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";

function skillFromWire(raw: Record<string, unknown>): HermesSkillInfo {
  const skill = parseSkill(raw);
  if (!skill) throw new Error("fixture did not parse");
  return skill;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

describe("skill detail — frontmatter parsing", () => {
  it("splits a document into frontmatter and body", () => {
    const doc =
      "---\nname: pdf\ndescription: Read PDFs\n---\n# Heading\n\nBody text.\n";
    const parts = splitSkillDocument(doc);
    expect(parts.hasFrontmatter).toBe(true);
    expect(parts.frontmatter).toContain("name: pdf");
    expect(parts.body).toBe("# Heading\n\nBody text.\n");
  });

  it("treats a document with no fence as all body", () => {
    const parts = splitSkillDocument("# Just a body\nno frontmatter");
    expect(parts.hasFrontmatter).toBe(false);
    expect(parts.frontmatter).toBeUndefined();
    expect(parts.body).toContain("Just a body");
  });

  it("tolerates CRLF and a BOM", () => {
    const doc = "﻿---\r\nname: x\r\n---\r\nbody\r\n";
    const parts = splitSkillDocument(doc);
    expect(parts.hasFrontmatter).toBe(true);
    expect(readFrontmatterScalars(parts.frontmatter ?? "").name).toBe("x");
  });

  it("reads top-level scalars, unwraps quotes, and ignores nested keys", () => {
    const scalars = readFrontmatterScalars(
      'name: "pdf"\ndescription: Read PDFs\nmetadata:\n  nested: skip\nversion: 1.2.0',
    );
    expect(scalars.name).toBe("pdf");
    expect(scalars.description).toBe("Read PDFs");
    expect(scalars.version).toBe("1.2.0");
    expect(scalars.nested).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("skill detail — validation", () => {
  const requireBoth = { requireName: true, requireDescription: true };

  it("passes a valid document", () => {
    const result = validateSkillContent(
      "---\nname: pdf\ndescription: Read PDFs\n---\nBody",
      requireBoth,
    );
    expect(result.canSave).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("blocks a missing name", () => {
    const result = validateSkillContent(
      "---\ndescription: only desc\n---\nBody",
      requireBoth,
    );
    expect(result.canSave).toBe(false);
    expect(result.issues.some((i) => i.message.includes("name"))).toBe(true);
  });

  it("blocks a missing required description", () => {
    const result = validateSkillContent(
      "---\nname: pdf\n---\nBody",
      requireBoth,
    );
    expect(result.canSave).toBe(false);
    expect(result.issues.some((i) => i.message.includes("description"))).toBe(
      true,
    );
  });

  it("does not require a description when the skill never had one", () => {
    const result = validateSkillContent("---\nname: pdf\n---\nBody", {
      requireName: true,
      requireDescription: false,
    });
    expect(result.canSave).toBe(true);
  });

  it("blocks an unterminated frontmatter fence", () => {
    const result = validateSkillContent(
      "---\nname: pdf\nno closing fence here",
      requireBoth,
    );
    expect(result.canSave).toBe(false);
    expect(
      result.issues.some((i) =>
        i.message.toLowerCase().includes("unterminated"),
      ),
    ).toBe(true);
  });

  it("blocks a document over the size limit", () => {
    const big =
      "---\nname: x\ndescription: y\n---\n" +
      "a".repeat(SKILL_MD_MAX_BYTES + 1);
    const result = validateSkillContent(big, requireBoth);
    expect(result.canSave).toBe(false);
    expect(result.issues.some((i) => i.message.includes("too large"))).toBe(
      true,
    );
  });

  it("warns (but does not block) on a secret-looking value, without leaking it", () => {
    const secret = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const result = validateSkillContent(
      `---\nname: x\ndescription: y\n---\napi_key: ${secret}`,
      requireBoth,
    );
    // It is a warning, not an error — save is still allowed.
    expect(result.canSave).toBe(true);
    const warning = result.issues.find((i) => i.severity === "warning");
    expect(warning).toBeDefined();
    // The matched secret never appears in the user-facing message.
    expect(JSON.stringify(result.issues)).not.toContain(secret);
  });
});

describe("skill detail — secret scan", () => {
  it("flags assignments under secret keys and known prefixes by line", () => {
    const findings = scanForSecrets(
      [
        "name: pdf",
        "api_key: ghp_0123456789abcdefghijklmnopqrstuvwxyz",
        "see the docs at /usr/local/share",
        "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123",
      ].join("\n"),
    );
    const lines = findings.map((f) => f.line);
    expect(lines).toContain(2);
    expect(lines).toContain(4);
    // The path line is not a credential.
    expect(lines).not.toContain(3);
  });

  it("does not flag ordinary prose", () => {
    expect(
      scanForSecrets("This skill helps you write a great summary.\n"),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edit policy / provenance
// ---------------------------------------------------------------------------

describe("skill detail — edit policy", () => {
  it("makes a local/unknown skill editable with no warning", () => {
    const policy = skillEditPolicy({ source: "unknown", readOnly: false });
    expect(policy.editable).toBe(true);
    expect(policy.warning).toBeUndefined();
  });

  it("makes a bundled skill editable but warns about update drift", () => {
    const policy = skillEditPolicy({ source: "bundled", readOnly: false });
    expect(policy.editable).toBe(true);
    expect(policy.warning).toContain("bundled updates");
  });

  it("makes a hub skill editable but warns about upstream divergence", () => {
    const policy = skillEditPolicy({ source: "hub", readOnly: false });
    expect(policy.editable).toBe(true);
    expect(policy.warning?.toLowerCase()).toContain("upstream");
  });

  it("makes an external skill read-only with a reason", () => {
    const policy = skillEditPolicy({ source: "external", readOnly: false });
    expect(policy.editable).toBe(false);
    expect(policy.readOnlyReason).toBeTruthy();
  });

  it("honors a hard read-only flag even for an otherwise-editable source", () => {
    const policy = skillEditPolicy({ source: "bundled", readOnly: true });
    expect(policy.editable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Supporting files
// ---------------------------------------------------------------------------

describe("skill detail — supporting files", () => {
  it("groups files by directory and excludes SKILL.md", () => {
    const skill = skillFromWire({
      name: "pdf",
      enabled: true,
      files: [
        "SKILL.md",
        "references/spec.md",
        "templates/letter.md",
        "scripts/run.sh",
        "assets/logo.png",
        "notes.txt",
      ],
    });
    const groups = skillSupportingFiles(skill);
    expect(groups.references).toEqual(["references/spec.md"]);
    expect(groups.templates).toEqual(["templates/letter.md"]);
    expect(groups.scripts).toEqual(["scripts/run.sh"]);
    expect(groups.assets).toEqual(["assets/logo.png"]);
    expect(groups.other).toEqual(["notes.txt"]);
  });

  it("returns empty groups when nothing is reported", () => {
    const skill = skillFromWire({ name: "pdf", enabled: true });
    const groups = skillSupportingFiles(skill);
    expect(groups.references).toHaveLength(0);
    expect(groups.scripts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

describe("skill detail — diff", () => {
  it("reports no change for identical content", () => {
    const diff = diffSkillContent("a\nb\n", "a\nb\n");
    expect(diff.unchanged).toBe(true);
    expect(diff.addedCount).toBe(0);
    expect(diff.removedCount).toBe(0);
  });

  it("reports added and removed lines", () => {
    const diff = diffSkillContent("a\nb\nc", "a\nB\nc");
    expect(diff.unchanged).toBe(false);
    expect(diff.addedCount).toBe(1);
    expect(diff.removedCount).toBe(1);
    expect(diff.lines.some((l) => l.kind === "added" && l.text === "B")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Controller (real client against the fake server)
// ---------------------------------------------------------------------------

const WRITABLE = "---\nname: pdf\ndescription: Read PDFs\n---\nOriginal body.";

function localSkill(): HermesSkillInfo {
  return skillFromWire({
    name: "pdf",
    description: "Read PDFs",
    enabled: true,
    source: "bundled",
  });
}

function externalSkill(): HermesSkillInfo {
  return skillFromWire({
    name: "company-style",
    enabled: true,
    source: "external",
    read_only: true,
  });
}

describe("skill detail — controller", () => {
  it("loads SKILL.md, splits it, and scopes the request to the profile", async () => {
    const harness = makeAdminHarness(
      {
        skills: [{ name: "pdf", enabled: true, source: "bundled" }],
        skillContent: { pdf: WRITABLE },
      },
      { profile: "work" },
    );
    const controller = new SkillDetailController(
      harness as unknown as SkillDetailEngine,
      "pdf",
      localSkill(),
    );
    await controller.load();

    const snapshot = controller.getSnapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.original).toBe(WRITABLE);
    expect(snapshot.parts.hasFrontmatter).toBe(true);
    // The content read went through the profile-scoped endpoint.
    const get = harness.server.requestLog.find(
      (e) => e.path === "/api/skills/content" && e.method === "GET",
    );
    expect(get?.query.profile).toBe("work");
    expect(get?.query.name).toBe("pdf");
    controller.dispose();
  });

  it("saves an edit, records a next-session notification, and persists", async () => {
    const harness = makeAdminHarness({
      skills: [{ name: "pdf", enabled: true, source: "bundled" }],
      skillContent: { pdf: WRITABLE },
    });
    const controller = new SkillDetailController(
      harness as unknown as SkillDetailEngine,
      "pdf",
      localSkill(),
    );
    await controller.load();

    const edited = WRITABLE.replace("Original body.", "Edited body.");
    controller.setDraft(edited);
    expect(controller.getSnapshot().dirty).toBe(true);
    expect(controller.getSnapshot().diff.unchanged).toBe(false);

    await controller.save();
    const snapshot = controller.getSnapshot();
    expect(snapshot.dirty).toBe(false);
    expect(snapshot.original).toBe(edited);
    expect(snapshot.lifecycle.state).toBe("changes-apply-next-session");
    expect(snapshot.notifications.at(-1)?.timing).toBe("next-session");
    expect(snapshot.notifications.at(-1)?.message).toContain("New sessions");

    // The fake server actually rewrote the content.
    const fresh = await harness.client.skills.getContent("pdf");
    expect(fresh.content).toBe(edited);
    controller.dispose();
  });

  it("refuses to save an invalid draft (no wire call)", async () => {
    const harness = makeAdminHarness({
      skills: [{ name: "pdf", enabled: true, source: "bundled" }],
      skillContent: { pdf: WRITABLE },
    });
    const controller = new SkillDetailController(
      harness as unknown as SkillDetailEngine,
      "pdf",
      localSkill(),
    );
    await controller.load();
    const updateSpy = vi.spyOn(harness.client.skills, "updateContent");

    // Remove the name -> validation error -> save is a logic no-op.
    controller.setDraft("---\ndescription: only\n---\nBody");
    expect(controller.getSnapshot().validation.canSave).toBe(false);
    await controller.save();
    expect(updateSpy).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("refuses to save a read-only skill (enforced, not styled)", async () => {
    const harness = makeAdminHarness({
      skills: [
        {
          name: "company-style",
          enabled: true,
          source: "external",
          read_only: true,
        },
      ],
      skillContent: { "company-style": WRITABLE },
    });
    const controller = new SkillDetailController(
      harness as unknown as SkillDetailEngine,
      "company-style",
      externalSkill(),
    );
    await controller.load();
    expect(controller.getSnapshot().policy.editable).toBe(false);

    const updateSpy = vi.spyOn(harness.client.skills, "updateContent");
    controller.setDraft(WRITABLE + "\nedited");
    await controller.save();
    expect(updateSpy).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("surfaces a safe error when the save fails", async () => {
    const harness = makeAdminHarness({
      skills: [{ name: "pdf", enabled: true, source: "bundled" }],
      skillContent: { pdf: WRITABLE },
    });
    const controller = new SkillDetailController(
      harness as unknown as SkillDetailEngine,
      "pdf",
      localSkill(),
    );
    await controller.load();
    vi.spyOn(harness.client.skills, "updateContent").mockRejectedValueOnce(
      new Error("boom"),
    );
    controller.setDraft(WRITABLE.replace("Original", "Changed"));
    await controller.save();
    const snapshot = controller.getSnapshot();
    expect(snapshot.error).toBeTruthy();
    expect(snapshot.dirty).toBe(true);
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Component view (render-only, stubbed state)
// ---------------------------------------------------------------------------

function baseState(over: Partial<SkillDetailState>): SkillDetailState {
  const info = localSkill();
  return {
    status: "ready",
    skill: "pdf",
    info,
    relativePath: "SKILL.md",
    original: WRITABLE,
    draft: WRITABLE,
    parts: splitSkillDocument(WRITABLE),
    supportingFiles: skillSupportingFiles(info),
    policy: skillEditPolicy({ source: "bundled", readOnly: false }),
    validation: validateSkillContent(WRITABLE, {
      requireName: true,
      requireDescription: true,
    }),
    diff: diffSkillContent(WRITABLE, WRITABLE),
    dirty: false,
    saving: false,
    mode: "sandboxed",
    profile: "default",
    retryable: false,
    lifecycle: {
      state: "clean",
      label: "Up to date",
      detail: "No pending changes.",
      canRestart: false,
    },
    notifications: [],
    refresh: vi.fn(),
    setDraft: vi.fn(),
    revert: vi.fn(),
    save: vi.fn(),
    dismissNotification: vi.fn(),
    ...over,
  };
}

describe("skill detail — component", () => {
  it("renders a read-only external skill with no editor", () => {
    const info = externalSkill();
    render(
      <SkillDetailView
        state={baseState({
          skill: "company-style",
          info,
          policy: skillEditPolicy({ source: "external", readOnly: true }),
        })}
      />,
    );
    expect(screen.getAllByText(/read only/i).length).toBeGreaterThan(0);
    // No editor textarea for a read-only skill.
    expect(
      screen.queryByLabelText(/skill instructions and metadata/i),
    ).toBeNull();
    // The instructions are shown as a read view instead.
    expect(screen.getByText(/instructions/i)).toBeInTheDocument();
  });

  it("renders an editor for a writable skill and a pre-edit warning", () => {
    render(<SkillDetailView state={baseState({})} />);
    expect(
      screen.getByLabelText(/skill instructions and metadata/i),
    ).toBeInTheDocument();
    // The bundled pre-edit warning is shown.
    expect(screen.getByText(/bundled updates/i)).toBeInTheDocument();
  });

  it("opens a diff confirmation and saves through it", () => {
    const save = vi.fn();
    const edited = WRITABLE.replace("Original body.", "Edited body.");
    render(
      <SkillDetailView
        state={baseState({
          draft: edited,
          dirty: true,
          diff: diffSkillContent(WRITABLE, edited),
          validation: validateSkillContent(edited, {
            requireName: true,
            requireDescription: true,
          }),
          save,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /review and save/i }));
    const dialog = screen.getByRole("dialog", {
      name: /review changes before saving/i,
    });
    expect(within(dialog).getByText(/added/)).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: /save changes/i }),
    );
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("disables save when the draft is invalid", () => {
    const invalid = "---\ndescription: only\n---\nBody";
    render(
      <SkillDetailView
        state={baseState({
          draft: invalid,
          dirty: true,
          validation: validateSkillContent(invalid, {
            requireName: true,
            requireDescription: true,
          }),
        })}
      />,
    );
    expect(
      screen.getByRole("button", { name: /review and save/i }),
    ).toBeDisabled();
    // The blocking error is shown inline.
    expect(screen.getByText(/missing a name/i)).toBeInTheDocument();
  });
});
