import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ExternalDirsController,
  addDir,
  buildExternalDirRows,
  presenceMeta,
  readExternalDirs,
  removeDir,
  shadowingExplanation,
  validateNewDir,
  writabilityMeta,
  type ExternalDirsEngine,
  type ExternalDirsState,
  type HermesSkillInfo,
} from "../lib/hermes-admin";
import { ExternalDirsView } from "../components/settings/ExternalDirsSection";
import type { ExternalDirStatus } from "../lib/tauri";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";

/** A wire-shaped external dir status with sensible defaults a test can override. */
function status(
  overrides: Partial<ExternalDirStatus> & { rawPath: string },
): ExternalDirStatus {
  return {
    resolvedPath: overrides.rawPath,
    unresolvedVar: null,
    exists: true,
    isDir: true,
    readable: true,
    writable: false,
    skillCount: 0,
    skillNames: [],
    ...overrides,
  };
}

/** A minimal HermesSkillInfo for shadowing tests. */
function skill(
  name: string,
  source: HermesSkillInfo["source"],
): HermesSkillInfo {
  return { name, enabled: true, source, raw: {} };
}

// ---------------------------------------------------------------------------
// Pure view logic. No render, no network.
// ---------------------------------------------------------------------------

describe("external dirs — config read", () => {
  it("reads the external_dirs list from the config tree", () => {
    expect(
      readExternalDirs({
        skills: { external_dirs: ["~/team-skills", "${TEAM}/skills"] },
      }),
    ).toEqual(["~/team-skills", "${TEAM}/skills"]);
  });

  it("tolerates a missing key, a bare string, and non-string entries", () => {
    expect(readExternalDirs({})).toEqual([]);
    expect(readExternalDirs({ skills: { external_dirs: "~/one" } })).toEqual([
      "~/one",
    ]);
    expect(
      readExternalDirs({ skills: { external_dirs: ["ok", 42, "", null] } }),
    ).toEqual(["ok"]);
  });
});

describe("external dirs — path expansion display", () => {
  it("shows the resolved path only when it differs from the raw one", () => {
    const rows = buildExternalDirRows(
      ["~/skills", "/abs/skills"],
      [
        status({ rawPath: "~/skills", resolvedPath: "/Users/me/skills" }),
        status({ rawPath: "/abs/skills", resolvedPath: "/abs/skills" }),
      ],
      [],
    );
    expect(rows[0].expanded).toBe(true);
    expect(rows[0].resolvedPath).toBe("/Users/me/skills");
    // Same raw and resolved → not flagged as expanded (UI hides the line).
    expect(rows[1].expanded).toBe(false);
  });

  it("surfaces an unresolved variable instead of a resolved path", () => {
    const rows = buildExternalDirRows(
      ["${MISSING}/skills"],
      [
        status({
          rawPath: "${MISSING}/skills",
          resolvedPath: null,
          unresolvedVar: "MISSING",
          exists: false,
          isDir: false,
          readable: false,
          writable: null,
          skillCount: null,
        }),
      ],
      [],
    );
    expect(rows[0].presence).toBe("unresolved");
    expect(rows[0].unresolvedVar).toBe("MISSING");
    expect(rows[0].resolvedPath).toBeUndefined();
  });
});

describe("external dirs — status labels", () => {
  it("labels missing dirs as non-fatal info, not an error", () => {
    const rows = buildExternalDirRows(
      ["/gone"],
      [
        status({
          rawPath: "/gone",
          exists: false,
          isDir: false,
          readable: false,
          writable: null,
          skillCount: null,
        }),
      ],
      [],
    );
    expect(rows[0].presence).toBe("missing");
    expect(presenceMeta(rows[0].presence)).toEqual({
      label: "Missing",
      tone: "info",
    });
  });

  it("labels an unreadable dir and an existing-but-not-a-folder path", () => {
    const rows = buildExternalDirRows(
      ["/locked", "/afile"],
      [
        status({ rawPath: "/locked", readable: false, skillCount: null }),
        status({
          rawPath: "/afile",
          isDir: false,
          readable: false,
          skillCount: null,
        }),
      ],
      [],
    );
    expect(rows[0].presence).toBe("unreadable");
    expect(rows[1].presence).toBe("not-a-directory");
  });

  it("distinguishes writable (warning), read-only, and unknown writability", () => {
    const rows = buildExternalDirRows(
      ["/w", "/r", "/u"],
      [
        status({ rawPath: "/w", writable: true }),
        status({ rawPath: "/r", writable: false }),
        status({ rawPath: "/u", writable: null }),
      ],
      [],
    );
    expect(rows[0].writability).toBe("writable");
    // Disk-writable is an active warning only in Full mode; under the sandbox
    // the write-jail blocks the agent, so it is informational there.
    expect(writabilityMeta("writable", "unrestricted").tone).toBe("warning");
    expect(writabilityMeta("writable", "sandboxed").tone).toBe("muted");
    expect(rows[1].writability).toBe("read-only");
    expect(rows[2].writability).toBe("unknown");
  });

  it("reports discovered-skill count and always treats external skills as read-only", () => {
    const rows = buildExternalDirRows(
      ["/s"],
      [status({ rawPath: "/s", skillCount: 3, skillNames: ["a", "b", "c"] })],
      [],
    );
    expect(rows[0].skillCount).toBe(3);
    expect(rows[0].readOnlyInJune).toBe(true);
  });
});

describe("external dirs — duplicate skill shadowing", () => {
  it("explains which external skills a same-named local skill shadows", () => {
    const rows = buildExternalDirRows(
      ["/team"],
      [
        status({
          rawPath: "/team",
          skillCount: 2,
          skillNames: ["pdf", "research"],
        }),
      ],
      // A bundled local skill named "pdf" shadows the external "pdf".
      [skill("pdf", "bundled"), skill("research-other", "hub")],
    );
    expect(rows[0].shadowedByLocal).toEqual(["pdf"]);
    const explanation = shadowingExplanation(rows[0]);
    expect(explanation).toContain("pdf");
    expect(explanation).toContain("take precedence");
  });

  it("does not let an external local skill shadow another external skill", () => {
    const rows = buildExternalDirRows(
      ["/team"],
      [status({ rawPath: "/team", skillCount: 1, skillNames: ["pdf"] })],
      // The only "pdf" is itself external — it must NOT count as a shadower.
      [skill("pdf", "external")],
    );
    expect(rows[0].shadowedByLocal).toEqual([]);
    expect(shadowingExplanation(rows[0])).toBeUndefined();
  });
});

describe("external dirs — add/remove list math", () => {
  it("rejects empty and duplicate paths and accepts a new one", () => {
    expect(validateNewDir("  ", []).ok).toBe(false);
    expect(validateNewDir("~/skills", ["~/skills"]).ok).toBe(false);
    const ok = validateNewDir("  ~/new  ", ["~/old"]);
    expect(ok).toEqual({ ok: true, value: "~/new" });
  });

  it("adds and removes without mutating the source array", () => {
    const existing = ["~/a"];
    expect(addDir(existing, "~/b")).toEqual(["~/a", "~/b"]);
    expect(removeDir(["~/a", "~/b"], "~/a")).toEqual(["~/b"]);
    expect(existing).toEqual(["~/a"]); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Controller — config writes through the fake Hermes server.
// ---------------------------------------------------------------------------

/** Builds a controller engine from the admin harness plus an injected inspect. */
function engineFor(
  config: Record<string, unknown>,
  skills: Array<Record<string, unknown>> = [],
  inspect?: ExternalDirsEngine["inspect"],
): {
  engine: ExternalDirsEngine;
  server: ReturnType<typeof makeAdminHarness>["server"];
} {
  const harness = makeAdminHarness({ config, skills: skills as never });
  const engine: ExternalDirsEngine = {
    ...harness,
    inspect:
      inspect ?? (async (dirs) => dirs.map((rawPath) => status({ rawPath }))),
  };
  return { engine, server: harness.server };
}

describe("external dirs — config write", () => {
  it("loads the configured dirs and joins them with filesystem status", async () => {
    const { engine } = engineFor(
      { skills: { external_dirs: ["~/team"] } },
      [],
      async (dirs) =>
        dirs.map((rawPath) =>
          status({
            rawPath,
            resolvedPath: "/Users/me/team",
            skillCount: 1,
            skillNames: ["caveman"],
          }),
        ),
    );
    const controller = new ExternalDirsController(engine);
    await controller.load();

    const snapshot = controller.getSnapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.rawDirs).toEqual(["~/team"]);
    expect(snapshot.rows[0].resolvedPath).toBe("/Users/me/team");
    expect(snapshot.rows[0].skillCount).toBe(1);
    controller.dispose();
  });

  it("adds a directory, writes the merged list, and records a next-session notice", async () => {
    const { engine } = engineFor({ skills: { external_dirs: ["~/team"] } });
    const controller = new ExternalDirsController(engine);
    await controller.load();

    const reason = await controller.add("~/shared");
    expect(reason).toBeUndefined();

    // The fake server actually persisted the merged list.
    const after = await engine.client.config.get();
    expect(readExternalDirs(after.config)).toEqual(["~/team", "~/shared"]);

    const snapshot = controller.getSnapshot();
    expect(snapshot.rawDirs).toEqual(["~/team", "~/shared"]);
    expect(snapshot.lifecycle.state).toBe("changes-apply-next-session");
    expect(snapshot.notifications.at(-1)?.timing).toBe("next-session");
    expect(snapshot.notifications.at(-1)?.message).toContain("New sessions");
    controller.dispose();
  });

  it("rejects a duplicate add without writing", async () => {
    const { engine } = engineFor({ skills: { external_dirs: ["~/team"] } });
    const setValue = vi.spyOn(engine.client.config, "setValue");
    const controller = new ExternalDirsController(engine);
    await controller.load();

    const reason = await controller.add("~/team");
    expect(reason).toContain("already in the list");
    expect(setValue).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("removes a directory and writes the merged list", async () => {
    const { engine } = engineFor({
      skills: { external_dirs: ["~/team", "~/shared"] },
    });
    const controller = new ExternalDirsController(engine);
    await controller.load();

    await controller.remove("~/team");

    const after = await engine.client.config.get();
    expect(readExternalDirs(after.config)).toEqual(["~/shared"]);
    expect(controller.getSnapshot().rawDirs).toEqual(["~/shared"]);
    controller.dispose();
  });

  it("recomputes shadowing from the live skill list after a write", async () => {
    const { engine } = engineFor(
      { skills: { external_dirs: ["~/team"] } },
      [{ name: "pdf", enabled: true, source: "bundled" }],
      async (dirs) =>
        dirs.map((rawPath) =>
          status({ rawPath, skillCount: 1, skillNames: ["pdf"] }),
        ),
    );
    const controller = new ExternalDirsController(engine);
    await controller.load();
    // The bundled local "pdf" shadows the external "pdf".
    expect(controller.getSnapshot().rows[0].shadowedByLocal).toEqual(["pdf"]);
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// View rendering — labels and the warning copy.
// ---------------------------------------------------------------------------

function viewState(
  overrides: Partial<ExternalDirsState> = {},
): ExternalDirsState {
  return {
    status: "ready",
    rows: [],
    rawDirs: [],
    busy: false,
    retryable: false,
    lifecycle: {
      state: "clean",
      label: "Up to date",
      detail: "No pending changes.",
      canRestart: false,
    },
    notifications: [],
    refresh: () => {},
    add: () => Promise.resolve(undefined),
    remove: () => {},
    dismissNotification: () => {},
    ...overrides,
  };
}

describe("external dirs — view", () => {
  it("shows the sandbox-accurate shared-directory warning copy", () => {
    render(<ExternalDirsView state={viewState()} />);
    expect(
      screen.getByText(/External directories are shared skill sources/),
    ).toBeTruthy();
    expect(
      screen.getByText(/sandboxed runtime blocks writes/),
    ).toBeTruthy();
  });

  it("renders a row with resolved path, status labels, and read-only note", () => {
    const rows = buildExternalDirRows(
      ["~/team"],
      [
        status({
          rawPath: "~/team",
          resolvedPath: "/Users/me/team",
          writable: true,
          skillCount: 2,
          skillNames: ["a", "b"],
        }),
      ],
      [],
    );
    render(
      <ExternalDirsView state={viewState({ rows, rawDirs: ["~/team"] })} />,
    );
    const list = screen.getByRole("list");
    expect(
      within(list).getByText(/Resolves to \/Users\/me\/team/),
    ).toBeTruthy();
    expect(within(list).getByText("Writable on disk")).toBeTruthy();
    expect(within(list).getByText("Read only in June")).toBeTruthy();
    expect(within(list).getByText("2 skills found")).toBeTruthy();
  });

  it("calls remove with the raw configured path", () => {
    const onRemove = vi.fn();
    const rows = buildExternalDirRows(
      ["~/team"],
      [status({ rawPath: "~/team" })],
      [],
    );
    render(
      <ExternalDirsView
        state={viewState({ rows, rawDirs: ["~/team"], remove: onRemove })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove ~/team" }));
    expect(onRemove).toHaveBeenCalledWith("~/team");
  });
});
