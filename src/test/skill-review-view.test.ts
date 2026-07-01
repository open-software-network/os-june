import { describe, expect, it } from "vitest";
import {
  affectedFiles,
  canApprove,
  hasRedactedContent,
  opMeta,
  parsePendingSkillWrite,
  parsePendingSkillWrites,
  readWriteApproval,
  writeGist,
  writeSourceMeta,
  WRITE_APPROVAL_PATH,
} from "../lib/hermes-admin";

// ---------------------------------------------------------------------------
// Parsing the Tauri command result (the create/edit/delete shapes).
// ---------------------------------------------------------------------------

describe("parsePendingSkillWrite", () => {
  it("parses a readable edit with a diff and content", () => {
    const write = parsePendingSkillWrite({
      id: "change-1",
      skill: "research",
      op: "edit",
      source: "background",
      gist: "Tighten the checklist",
      stagedAt: 1_700_000_000_000,
      files: [
        {
          relativePath: "research/SKILL.md",
          diff: "@@\n-old\n+new\n",
          content: "new",
          redacted: false,
        },
      ],
      readable: true,
    });
    expect(write).not.toBeNull();
    expect(write?.op).toBe("edit");
    expect(write?.source).toBe("background");
    expect(write?.gist).toBe("Tighten the checklist");
    expect(write?.readable).toBe(true);
    expect(affectedFiles(write!)).toEqual(["research/SKILL.md"]);
  });

  it("defaults an absent op/source to unknown and an unreadable manifest stays unapprovable", () => {
    const write = parsePendingSkillWrite({ id: "weird", readable: false });
    expect(write?.op).toBe("unknown");
    expect(write?.source).toBe("unknown");
    expect(canApprove(write!)).toBe(false);
  });

  it("drops an entry with no id", () => {
    expect(parsePendingSkillWrite({ skill: "x" })).toBeNull();
  });

  it("parses an array, skipping unparseable entries", () => {
    const list = parsePendingSkillWrites([
      {
        id: "a",
        op: "create",
        readable: true,
        files: [{ path: "a/SKILL.md", content: "c" }],
      },
      { skill: "no-id" },
      "garbage",
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("a");
    // `path` is accepted as a relativePath alias.
    expect(list[0].files[0].relativePath).toBe("a/SKILL.md");
  });
});

// ---------------------------------------------------------------------------
// Labeling, gists, and safety framing.
// ---------------------------------------------------------------------------

describe("write labeling and framing", () => {
  it("gives each op a safety effect string", () => {
    expect(opMeta("create").effect).toMatch(/Adds a new skill/);
    expect(opMeta("delete").effect).toMatch(/Removes a skill/);
    expect(opMeta("edit").effect).toMatch(/Changes an existing skill/);
  });

  it("explains each provenance source", () => {
    expect(writeSourceMeta("foreground").label).toBe("From a task");
    expect(writeSourceMeta("background").label).toBe("Self-improvement");
    expect(writeSourceMeta("unknown").blurb).toMatch(/did not report/);
  });

  it("derives a gist when the manifest supplies none", () => {
    const write = parsePendingSkillWrite({
      id: "x",
      skill: "git",
      op: "create",
      readable: true,
      files: [{ path: "git/SKILL.md", content: "c" }],
    })!;
    expect(writeGist(write)).toBe("Add skill git");
  });

  it("prefers the manifest gist", () => {
    const write = parsePendingSkillWrite({
      id: "x",
      skill: "git",
      op: "edit",
      gist: "Add a rebase step",
      readable: true,
      files: [{ path: "git/SKILL.md", content: "c" }],
    })!;
    expect(writeGist(write)).toBe("Add a rebase step");
  });

  it("flags redacted content so the UI can warn", () => {
    const write = parsePendingSkillWrite({
      id: "x",
      skill: "git",
      op: "edit",
      readable: true,
      files: [
        {
          path: "git/SKILL.md",
          content: "api_key: [redacted]",
          redacted: true,
        },
      ],
    })!;
    expect(hasRedactedContent(write)).toBe(true);
  });

  it("refuses to approve a readable write whose content was redacted", () => {
    // June only holds the masked copy of redacted content, so approving here
    // would persist `[redacted]` and corrupt the skill. Approve fails closed in
    // Rust; canApprove must mirror that so the UI never offers the action.
    const write = parsePendingSkillWrite({
      id: "x",
      skill: "git",
      op: "edit",
      readable: true,
      files: [
        {
          path: "git/SKILL.md",
          content: "api_key: [redacted]",
          redacted: true,
        },
      ],
    })!;
    expect(canApprove(write)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The write-approval gate reading.
// ---------------------------------------------------------------------------

describe("readWriteApproval", () => {
  it("reads a boolean true", () => {
    expect(readWriteApproval({ skills: { write_approval: true } })).toBe(true);
  });

  it("reads string and numeric truthiness", () => {
    expect(readWriteApproval({ skills: { write_approval: "true" } })).toBe(
      true,
    );
    expect(readWriteApproval({ skills: { write_approval: "false" } })).toBe(
      false,
    );
    expect(readWriteApproval({ skills: { write_approval: 1 } })).toBe(true);
    expect(readWriteApproval({ skills: { write_approval: 0 } })).toBe(false);
  });

  it("defaults to false when the key is absent", () => {
    expect(readWriteApproval({})).toBe(false);
    expect(readWriteApproval({ skills: {} })).toBe(false);
  });

  it("points at the documented config path", () => {
    expect(WRITE_APPROVAL_PATH).toBe("skills.write_approval");
  });
});
