import { describe, expect, it, vi } from "vitest";

import {
  SkillTapsController,
  type SkillTapsIo,
} from "../lib/hermes-admin/use-skill-taps";
import {
  isSafeTapRepo,
  looksLikeGithubAuthError,
  normalizeTapPath,
  tapSearchSource,
  tapTrustMeta,
  validateTapPath,
  validateTapRepo,
} from "../lib/hermes-admin/taps-view";
import type {
  HermesSkillTapDto,
  HermesSkillTapListResult,
  HermesSkillTapWriteResult,
} from "../lib/tauri";
import type { HermesHubSkillResult } from "../lib/hermes-admin/schemas";

function tap(
  repo: string,
  extra: Partial<HermesSkillTapDto> = {},
): HermesSkillTapDto {
  return { repo, trusted: false, ...extra };
}

function hubResult(
  identifier: string,
  overrides: Partial<HermesHubSkillResult> = {},
): HermesHubSkillResult {
  return {
    identifier,
    name: overrides.name ?? identifier,
    trust: overrides.trust ?? "community",
    raw: {},
    ...overrides,
  };
}

type FakeIo = {
  io: SkillTapsIo;
  store: HermesSkillTapDto[];
  addCalls: Array<{ repo: string; path?: string }>;
  removeCalls: string[];
  searchCalls: Array<{ query: string; source: string }>;
};

function makeIo(
  initial: HermesSkillTapDto[],
  options: {
    listResult?: () => HermesSkillTapListResult;
    addResult?: () => HermesSkillTapWriteResult;
    searchResults?: HermesHubSkillResult[];
  } = {},
): FakeIo {
  const store = [...initial];
  const addCalls: Array<{ repo: string; path?: string }> = [];
  const removeCalls: string[] = [];
  const searchCalls: Array<{ query: string; source: string }> = [];
  const io: SkillTapsIo = {
    list: async () =>
      options.listResult?.() ?? {
        ok: true,
        taps: [...store],
        message: null,
        timedOut: false,
      },
    add: async (repo, path) => {
      addCalls.push({ repo, path });
      const result = options.addResult?.() ?? {
        ok: true,
        message: null,
        timedOut: false,
      };
      if (result.ok && !store.some((t) => t.repo === repo)) {
        store.push({ repo, path, trusted: false });
      }
      return result;
    },
    remove: async (repo) => {
      removeCalls.push(repo);
      const idx = store.findIndex((t) => t.repo === repo);
      if (idx >= 0) store.splice(idx, 1);
      return { ok: true, message: null, timedOut: false };
    },
    hubSearch: async (query, source) => {
      searchCalls.push({ query, source });
      return options.searchResults ?? [];
    },
    hubInstall: async () => ({ result: undefined }),
  };
  return { io, store, addCalls, removeCalls, searchCalls };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("taps-view validation", () => {
  it("accepts safe owner/repo and rejects unsafe identifiers", () => {
    expect(validateTapRepo("acme/runbooks")).toBeNull();
    expect(validateTapRepo("acme-org/team.skills_1")).toBeNull();
    expect(isSafeTapRepo("acme/runbooks")).toBe(true);

    expect(validateTapRepo("")).not.toBeNull();
    expect(validateTapRepo("acme")).not.toBeNull();
    expect(validateTapRepo("acme/repo/extra")).not.toBeNull();
    expect(validateTapRepo("../acme/repo")).not.toBeNull();
    expect(validateTapRepo("acme/..")).not.toBeNull();
    expect(validateTapRepo("--flag/repo")).not.toBeNull();
    expect(validateTapRepo("acme/runbooks; rm -rf /")).not.toBeNull();
    expect(validateTapRepo("acme repo/runbooks")).not.toBeNull();
  });

  it("accepts safe path overrides and rejects traversal / metachars", () => {
    expect(validateTapPath("")).toBeNull(); // empty => default
    expect(validateTapPath("skills")).toBeNull();
    expect(validateTapPath("skills/ops")).toBeNull();
    expect(validateTapPath("skills/ops/")).toBeNull(); // trailing slash tolerated
    expect(validateTapPath(".github/skills")).toBeNull();

    expect(validateTapPath("/etc/passwd")).not.toBeNull();
    expect(validateTapPath("../escape")).not.toBeNull();
    expect(validateTapPath("skills/../../etc")).not.toBeNull();
    expect(validateTapPath("skills/ops;rm -rf")).not.toBeNull();
    expect(validateTapPath("skills//ops")).not.toBeNull();
  });

  it("normalizes a path to undefined when empty and drops a trailing slash", () => {
    expect(normalizeTapPath("")).toBeUndefined();
    expect(normalizeTapPath("   ")).toBeUndefined();
    expect(normalizeTapPath("skills/")).toBe("skills");
    expect(normalizeTapPath("skills/ops")).toBe("skills/ops");
  });

  it("marks a tap community unless trusted", () => {
    expect(tapTrustMeta(tap("a/b")).level).toBe("community");
    expect(tapTrustMeta(tap("a/b")).tone).toBe("caution");
    expect(tapTrustMeta(tap("a/b", { trusted: true })).level).toBe("trusted");
  });

  it("recognizes GitHub rate-limit / auth errors", () => {
    expect(looksLikeGithubAuthError("API rate limit exceeded")).toBe(true);
    expect(looksLikeGithubAuthError("HTTP 403 Forbidden")).toBe(true);
    expect(looksLikeGithubAuthError("repository not found (private?)")).toBe(
      true,
    );
    expect(looksLikeGithubAuthError("network unreachable")).toBe(false);
    expect(looksLikeGithubAuthError(null)).toBe(false);
  });

  it("scopes the hub search source to the tap repo", () => {
    expect(tapSearchSource("  acme/runbooks ")).toBe("acme/runbooks");
  });
});

describe("SkillTapsController", () => {
  it("loads and lists configured taps sorted by repo", async () => {
    const { io } = makeIo([tap("z/last"), tap("a/first")]);
    const controller = new SkillTapsController(io, "sandboxed");
    await controller.load();
    const state = controller.getSnapshot();
    expect(state.status).toBe("ready");
    expect(state.taps.map((t) => t.repo)).toEqual(["a/first", "z/last"]);
  });

  it("adds a tap with a normalized path and refreshes", async () => {
    const fake = makeIo([]);
    const controller = new SkillTapsController(fake.io, "sandboxed");
    await controller.load();
    await controller.addTap("acme/runbooks", "skills/ops/");
    await flush();
    expect(fake.addCalls).toEqual([
      { repo: "acme/runbooks", path: "skills/ops" },
    ]);
    expect(controller.getSnapshot().taps.map((t) => t.repo)).toContain(
      "acme/runbooks",
    );
    expect(controller.getSnapshot().notifications.at(-1)?.message).toContain(
      "acme/runbooks",
    );
  });

  it("rejects an unsafe repo before it reaches the bridge", async () => {
    const fake = makeIo([]);
    const controller = new SkillTapsController(fake.io, "sandboxed");
    await controller.load();
    await controller.addTap("acme/runbooks; rm -rf /", "");
    expect(fake.addCalls).toHaveLength(0);
    expect(controller.getSnapshot().error).not.toBeUndefined();
  });

  it("rejects an unsafe path before it reaches the bridge", async () => {
    const fake = makeIo([]);
    const controller = new SkillTapsController(fake.io, "sandboxed");
    await controller.load();
    await controller.addTap("acme/runbooks", "../escape");
    expect(fake.addCalls).toHaveLength(0);
    expect(controller.getSnapshot().error).not.toBeUndefined();
  });

  it("never sends an unsafe identifier to remove", async () => {
    const fake = makeIo([tap("acme/runbooks")]);
    const controller = new SkillTapsController(fake.io, "sandboxed");
    await controller.load();
    await controller.removeTap("../evil");
    expect(fake.removeCalls).toHaveLength(0);
  });

  it("removes a tap and clears a search scoped to it", async () => {
    const fake = makeIo([tap("acme/runbooks")], {
      searchResults: [hubResult("acme/runbooks/deploy")],
    });
    const controller = new SkillTapsController(fake.io, "sandboxed");
    await controller.load();
    await controller.searchTap("acme/runbooks");
    await flush();
    expect(controller.getSnapshot().search.repo).toBe("acme/runbooks");
    await controller.removeTap("acme/runbooks");
    await flush();
    expect(fake.removeCalls).toEqual(["acme/runbooks"]);
    expect(controller.getSnapshot().search.repo).toBeUndefined();
  });

  it("surfaces a token-setup hint when listing hits a rate-limit error", async () => {
    const { io } = makeIo([], {
      listResult: () => ({
        ok: false,
        taps: [],
        message: "API rate limit exceeded",
        timedOut: false,
      }),
    });
    const controller = new SkillTapsController(io, "sandboxed");
    await controller.load();
    const state = controller.getSnapshot();
    expect(state.needsGithubToken).toBe(true);
    expect(state.error).toContain("rate limit");
  });

  it("surfaces a token-setup hint when adding a private tap fails", async () => {
    const fake = makeIo([], {
      addResult: () => ({
        ok: false,
        message: "404 Not Found (repository is private)",
        timedOut: false,
      }),
    });
    const controller = new SkillTapsController(fake.io, "sandboxed");
    await controller.load();
    await controller.addTap("acme/private", "");
    await flush();
    expect(controller.getSnapshot().needsGithubToken).toBe(true);
  });

  it("searches a tap scoped to its source and filters by identifier", async () => {
    const fake = makeIo([tap("acme/runbooks")], {
      searchResults: [
        hubResult("acme/runbooks/deploy", { name: "Deploy" }),
        hubResult("other/unrelated/thing", { name: "Unrelated" }),
      ],
    });
    const controller = new SkillTapsController(fake.io, "sandboxed");
    await controller.load();
    await controller.searchTap("acme/runbooks", "dep");
    await flush();
    expect(fake.searchCalls).toEqual([
      { query: "dep", source: "acme/runbooks" },
    ]);
    const results = controller.getSnapshot().search.results.map((r) => r.name);
    expect(results).toEqual(["Deploy"]);
  });

  it("installs a tap skill via the reused hub flow and notifies", async () => {
    const installSpy = vi.fn(async () => ({ result: undefined }));
    const fake = makeIo([tap("acme/runbooks")], {
      searchResults: [hubResult("acme/runbooks/deploy", { name: "Deploy" })],
    });
    fake.io.hubInstall = installSpy;
    const controller = new SkillTapsController(fake.io, "sandboxed");
    await controller.load();
    await controller.searchTap("acme/runbooks");
    await flush();
    const result = controller.getSnapshot().search.results[0];
    await controller.installSkill(result);
    await flush();
    expect(installSpy).toHaveBeenCalledWith("acme/runbooks/deploy");
    expect(
      controller.getSnapshot().installs.get("acme/runbooks/deploy")?.phase,
    ).toBe("done");
    expect(controller.getSnapshot().notifications.at(-1)?.message).toContain(
      "Deploy",
    );
  });

  it("surfaces an install failure inline", async () => {
    const fake = makeIo([tap("acme/runbooks")], {
      searchResults: [hubResult("acme/runbooks/deploy")],
    });
    fake.io.hubInstall = async () => ({
      result: {
        action: "install",
        state: "failed",
        done: true,
        error: "scan blocked",
        raw: {},
      },
    });
    const controller = new SkillTapsController(fake.io, "sandboxed");
    await controller.load();
    await controller.searchTap("acme/runbooks");
    await flush();
    const result = controller.getSnapshot().search.results[0];
    await controller.installSkill(result);
    await flush();
    const install = controller
      .getSnapshot()
      .installs.get("acme/runbooks/deploy");
    expect(install?.phase).toBe("failed");
    expect(install?.error).toContain("scan blocked");
  });
});
