import { describe, expect, it } from "vitest";

import {
  BUNDLE_SLUG_MAX_LENGTH,
  bundleChatPrompt,
  bundleDisplayName,
  bundleSlashCommand,
  duplicateBundle,
  isSafeBundleSlug,
  normalizeBundleSlug,
  parseBundleSkillsInput,
  resolveBundle,
  validateBundleDraft,
  type SkillBundle,
} from "../lib/hermes-admin/skill-bundles-view";
import type { HermesSkillInfo } from "../lib/hermes-admin/schemas";

function skill(name: string, enabled = true): HermesSkillInfo {
  return { name, enabled, source: "hub", raw: {} };
}

const INSTALLED: HermesSkillInfo[] = [
  skill("backend-dev"),
  skill("database"),
  skill("team/incident-response"),
];

describe("normalizeBundleSlug", () => {
  it("lowercases and hyphenates free text", () => {
    expect(normalizeBundleSlug("Backend Dev")).toBe("backend-dev");
    expect(normalizeBundleSlug("  Release   Prep!  ")).toBe("release-prep");
  });

  it("strips disallowed characters and collapses separators", () => {
    expect(normalizeBundleSlug("backend/../dev")).toBe("backend-dev");
    expect(normalizeBundleSlug("a@@@b")).toBe("a-b");
    expect(normalizeBundleSlug("--lead--")).toBe("lead");
  });

  it("never exceeds the max length", () => {
    const long = "x".repeat(200);
    expect(normalizeBundleSlug(long).length).toBe(BUNDLE_SLUG_MAX_LENGTH);
  });

  it("produces an empty string for unusable input", () => {
    expect(normalizeBundleSlug("///")).toBe("");
    expect(normalizeBundleSlug("   ")).toBe("");
  });

  it("always yields a safe slug or empty", () => {
    for (const input of ["Backend Dev", "a.b_c-d", "../escape", "9lives"]) {
      const slug = normalizeBundleSlug(input);
      expect(slug === "" || isSafeBundleSlug(slug)).toBe(true);
    }
  });
});

describe("isSafeBundleSlug", () => {
  it("accepts safe slash-command slugs", () => {
    expect(isSafeBundleSlug("backend-dev")).toBe(true);
    expect(isSafeBundleSlug("a.b_c-d")).toBe(true);
    expect(isSafeBundleSlug("9lives")).toBe(true);
  });

  it("rejects traversal and unsafe input", () => {
    expect(isSafeBundleSlug("")).toBe(false);
    expect(isSafeBundleSlug("..")).toBe(false);
    expect(isSafeBundleSlug("a/b")).toBe(false);
    expect(isSafeBundleSlug("a\\b")).toBe(false);
    expect(isSafeBundleSlug("-leading")).toBe(false);
    expect(isSafeBundleSlug("Has Space")).toBe(false);
    expect(isSafeBundleSlug("x".repeat(65))).toBe(false);
  });
});

describe("bundleSlashCommand / display name / chat prompt", () => {
  it("prefixes the slug with a slash", () => {
    expect(bundleSlashCommand("backend-dev")).toBe("/backend-dev");
  });
  it("falls back to the slug when no name is set", () => {
    expect(bundleDisplayName({ slug: "backend-dev", skills: [] })).toBe(
      "backend-dev",
    );
    expect(
      bundleDisplayName({ slug: "backend-dev", name: "Backend", skills: [] }),
    ).toBe("Backend");
  });
  it("the chat prompt is the slash command", () => {
    expect(bundleChatPrompt({ slug: "backend-dev", skills: [] })).toBe(
      "/backend-dev",
    );
  });
});

describe("parseBundleSkillsInput", () => {
  it("splits on newlines and commas, trims, dedupes", () => {
    expect(
      parseBundleSkillsInput("backend-dev\n database, backend-dev"),
    ).toEqual(["backend-dev", "database"]);
  });
  it("drops empty entries", () => {
    expect(parseBundleSkillsInput("\n\n , a , ")).toEqual(["a"]);
  });
});

describe("resolveBundle", () => {
  it("marks members resolved or missing and previews the slash command", () => {
    const bundle: SkillBundle = {
      slug: "backend-dev",
      skills: ["backend-dev", "database", "nope"],
    };
    const resolved = resolveBundle(bundle, INSTALLED);
    expect(resolved.slashCommand).toBe("/backend-dev");
    expect(resolved.members.map((m) => m.missing)).toEqual([
      false,
      false,
      true,
    ]);
    expect(resolved.hasMissing).toBe(true);
  });

  it("matches a bare member against a namespaced installed skill", () => {
    const bundle: SkillBundle = {
      slug: "incident",
      skills: ["incident-response"],
    };
    const resolved = resolveBundle(bundle, INSTALLED);
    expect(resolved.members[0].missing).toBe(false);
  });

  it("flags a slug that collides with an installed skill", () => {
    const bundle: SkillBundle = { slug: "database", skills: ["backend-dev"] };
    const resolved = resolveBundle(bundle, INSTALLED);
    expect(resolved.collidesWithSkill).toBe(true);
  });
});

describe("validateBundleDraft", () => {
  const base = { skills: INSTALLED, existingSlugs: [] as string[] };

  it("errors on an empty or unsafe slug", () => {
    const empty = validateBundleDraft(
      { slug: "", skills: ["backend-dev"] },
      base,
    );
    expect(empty.canSave).toBe(false);
    expect(
      empty.issues.some((i) => i.field === "slug" && i.severity === "error"),
    ).toBe(true);

    const unsafe = validateBundleDraft(
      { slug: "Bad Slug", skills: ["backend-dev"] },
      base,
    );
    expect(unsafe.canSave).toBe(false);
  });

  it("errors when the skills list is empty", () => {
    const result = validateBundleDraft({ slug: "ok", skills: [] }, base);
    expect(result.canSave).toBe(false);
    expect(
      result.issues.some((i) => i.field === "skills" && i.severity === "error"),
    ).toBe(true);
  });

  it("errors on a collision with another bundle slug", () => {
    const result = validateBundleDraft(
      { slug: "taken", skills: ["backend-dev"] },
      { skills: INSTALLED, existingSlugs: ["taken"] },
    );
    expect(result.canSave).toBe(false);
    expect(result.issues[0].field).toBe("slug");
  });

  it("warns but allows save when a member is not installed", () => {
    const result = validateBundleDraft(
      { slug: "mix", skills: ["backend-dev", "ghost"] },
      base,
    );
    expect(result.canSave).toBe(true);
    expect(
      result.issues.some(
        (i) => i.field === "skills" && i.severity === "warning",
      ),
    ).toBe(true);
  });

  it("warns about a skill-name collision but lets the bundle win", () => {
    const result = validateBundleDraft(
      { slug: "database", skills: ["backend-dev"] },
      base,
    );
    expect(result.canSave).toBe(true);
    const collision = result.issues.find(
      (i) => i.field === "slug" && i.severity === "warning",
    );
    expect(collision).toBeTruthy();
    expect(collision?.message.toLowerCase()).toContain("precedence");
  });
});

describe("duplicateBundle", () => {
  it("produces a fresh, non-colliding slug and a (copy) name", () => {
    const source: SkillBundle = {
      slug: "backend-dev",
      name: "Backend dev",
      skills: ["backend-dev"],
    };
    const copy = duplicateBundle(source, ["backend-dev", "backend-dev-copy"]);
    expect(copy.slug).not.toBe("backend-dev");
    expect(copy.slug).not.toBe("backend-dev-copy");
    expect(isSafeBundleSlug(copy.slug)).toBe(true);
    expect(copy.name).toBe("Backend dev (copy)");
    expect(copy.skills).toEqual(["backend-dev"]);
  });
});
