import { describe, expect, it, vi } from "vitest";

import {
  SkillBundlesController,
  type SkillBundlesIo,
} from "../lib/hermes-admin/use-skill-bundles";
import type { HermesSkillBundleDto } from "../lib/tauri";
import type { HermesSkillInfo } from "../lib/hermes-admin/schemas";

function skill(name: string): HermesSkillInfo {
  return { name, enabled: true, source: "hub", raw: {} };
}

function makeIo(
  initial: HermesSkillBundleDto[],
  skills: HermesSkillInfo[] = [],
): {
  io: SkillBundlesIo;
  store: HermesSkillBundleDto[];
  startChat: ReturnType<typeof vi.fn>;
} {
  const store = [...initial];
  const startChat = vi.fn();
  const io: SkillBundlesIo = {
    list: async () => [...store],
    loadSkills: async () => skills,
    save: async (bundle, previousSlug) => {
      const dto: HermesSkillBundleDto = {
        slug: bundle.slug,
        name: bundle.name,
        description: bundle.description,
        skills: bundle.skills,
        instructions: bundle.instructions,
      };
      if (previousSlug) {
        const idx = store.findIndex((b) => b.slug === previousSlug);
        if (idx >= 0) store.splice(idx, 1);
      }
      const existing = store.findIndex((b) => b.slug === bundle.slug);
      if (existing >= 0) store[existing] = dto;
      else store.push(dto);
      return dto;
    },
    remove: async (slug) => {
      const idx = store.findIndex((b) => b.slug === slug);
      if (idx >= 0) store.splice(idx, 1);
    },
    startChat,
  };
  return { io, store, startChat };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SkillBundlesController", () => {
  it("loads and resolves bundles against installed skills", async () => {
    const { io } = makeIo(
      [{ slug: "backend-dev", skills: ["backend-dev", "ghost"] }],
      [skill("backend-dev")],
    );
    const controller = new SkillBundlesController(io, "sandboxed");
    await controller.load();
    const state = controller.getSnapshot();
    expect(state.status).toBe("ready");
    expect(state.bundles).toHaveLength(1);
    expect(state.bundles[0].hasMissing).toBe(true);
    expect(state.bundles[0].slashCommand).toBe("/backend-dev");
  });

  it("creates a bundle and refreshes the list", async () => {
    const { io, store } = makeIo([], [skill("database")]);
    const controller = new SkillBundlesController(io, "sandboxed");
    await controller.load();
    await controller.save({ slug: "data", skills: ["database"] });
    await flush();
    expect(store.map((b) => b.slug)).toContain("data");
    expect(
      controller.getSnapshot().bundles.map((b) => b.bundle.slug),
    ).toContain("data");
    expect(controller.getSnapshot().notifications.at(-1)?.message).toContain(
      "/data",
    );
  });

  it("renames a bundle by removing the previous slug", async () => {
    const { io, store } = makeIo([{ slug: "old", skills: ["x"] }]);
    const controller = new SkillBundlesController(io, "sandboxed");
    await controller.load();
    await controller.save({ slug: "new", skills: ["x"] }, "old");
    await flush();
    expect(store.map((b) => b.slug)).toEqual(["new"]);
  });

  it("deletes a bundle", async () => {
    const { io, store } = makeIo([{ slug: "gone", skills: ["x"] }]);
    const controller = new SkillBundlesController(io, "sandboxed");
    await controller.load();
    await controller.remove("gone");
    await flush();
    expect(store).toHaveLength(0);
  });

  it("duplicates a bundle with a fresh slug", async () => {
    const { io, store } = makeIo([
      { slug: "backend-dev", name: "Backend", skills: ["backend-dev"] },
    ]);
    const controller = new SkillBundlesController(io, "sandboxed");
    await controller.load();
    await controller.duplicate("backend-dev");
    await flush();
    expect(store).toHaveLength(2);
    const copy = store.find((b) => b.slug !== "backend-dev");
    expect(copy?.slug).toMatch(/backend-dev-copy/);
    expect(copy?.name).toBe("Backend (copy)");
  });

  it("starts a chat with the bundle slash command", async () => {
    const { io, startChat } = makeIo([
      { slug: "backend-dev", skills: ["backend-dev"] },
    ]);
    const controller = new SkillBundlesController(io, "sandboxed");
    await controller.load();
    controller.startChat("backend-dev");
    expect(startChat).toHaveBeenCalledWith("/backend-dev");
  });

  it("surfaces a save failure as an error notification", async () => {
    const { io } = makeIo([]);
    io.save = async () => {
      throw new Error("disk full");
    };
    const controller = new SkillBundlesController(io, "sandboxed");
    await controller.load();
    await expect(controller.save({ slug: "x", skills: ["y"] })).rejects.toThrow(
      "disk full",
    );
    const note = controller.getSnapshot().notifications.at(-1);
    expect(note?.isError).toBe(true);
    expect(note?.message).toContain("disk full");
  });

  it("validates against other bundle slugs, excluding the one being edited", async () => {
    const { io } = makeIo(
      [
        { slug: "alpha", skills: ["x"] },
        { slug: "beta", skills: ["y"] },
      ],
      [skill("x")],
    );
    const controller = new SkillBundlesController(io, "sandboxed");
    await controller.load();
    // Renaming alpha -> beta collides.
    const collide = controller.validate(
      { slug: "beta", skills: ["x"] },
      "alpha",
    );
    expect(collide.canSave).toBe(false);
    // Editing beta in place does not collide with itself.
    const ok = controller.validate({ slug: "beta", skills: ["x"] }, "beta");
    expect(ok.canSave).toBe(true);
  });
});
