import { describe, expect, it } from "vitest";
import {
  AdminStateCache,
  adminTargetFromConnection,
  requiresGatewayRestart,
  resourcesForMutation,
  timingForMutation,
  timingLabel,
  type AdminResource,
} from "../lib/hermes-admin";
import type { HermesBridgeConnection } from "../lib/tauri";
import type { HermesActionStatus } from "../lib/hermes-admin";

function connection(
  overrides: Partial<HermesBridgeConnection> = {},
): HermesBridgeConnection {
  return {
    baseUrl: "http://127.0.0.1:1000",
    wsUrl: "ws://127.0.0.1:1000/api/ws",
    token: "t",
    port: 1000,
    command: "hermes",
    hermesHome: "/home/.hermes",
    cwd: null,
    providerProxyPort: 1,
    pid: 1,
    sandboxed: true,
    fullMode: false,
    ...overrides,
  };
}

function makeCache(
  profile = "default",
  overrides: Partial<HermesBridgeConnection> = {},
) {
  return new AdminStateCache(
    adminTargetFromConnection(connection(overrides), profile),
  );
}

describe("application timing — one map, consistent semantics", () => {
  it("classifies skill and toolset changes as next-session", () => {
    expect(timingForMutation("skill.toggle")).toBe("next-session");
    expect(timingForMutation("skill.hubInstall")).toBe("next-session");
    expect(timingForMutation("toolset.toggle")).toBe("next-session");
  });

  it("classifies MCP and env changes as gateway-restart", () => {
    for (const mutation of [
      "mcp.add",
      "mcp.remove",
      "mcp.setEnabled",
      "mcp.installCatalog",
      "env.set",
      "env.delete",
    ] as const) {
      expect(timingForMutation(mutation)).toBe("gateway-restart");
      expect(requiresGatewayRestart(mutation)).toBe(true);
    }
  });

  it("classifies mcp.test and gateway.restart as immediate", () => {
    expect(timingForMutation("mcp.test")).toBe("immediate");
    expect(timingForMutation("gateway.restart")).toBe("immediate");
    expect(requiresGatewayRestart("mcp.test")).toBe(false);
  });

  it("provides distinct, dash-free labels per timing", () => {
    expect(timingLabel("immediate")).toBe("Applies now");
    expect(timingLabel("next-session")).toBe("Applies next session");
    expect(timingLabel("gateway-restart")).toBe("Restart required");
    for (const label of [
      timingLabel("immediate"),
      timingLabel("next-session"),
      timingLabel("gateway-restart"),
    ]) {
      expect(label).not.toMatch(/[–—]/);
    }
  });
});

describe("invalidation rules — each mutation names its resources", () => {
  it("skill toggle invalidates only skills", () => {
    expect(resourcesForMutation("skill.toggle")).toEqual(["skills"]);
  });

  it("hub install invalidates skills, hub, and toolsets", () => {
    expect(resourcesForMutation("skill.hubInstall")).toEqual([
      "skills",
      "hubSearch",
      "toolsets",
    ]);
  });

  it("MCP add/remove/test invalidate both MCP servers and toolsets", () => {
    // A test can change which tools a server exposes (auth now valid, server
    // now reachable), so it refreshes toolsets too, per spec 02.
    expect(resourcesForMutation("mcp.add")).toEqual(["mcpServers", "toolsets"]);
    expect(resourcesForMutation("mcp.remove")).toEqual([
      "mcpServers",
      "toolsets",
    ]);
    expect(resourcesForMutation("mcp.test")).toEqual([
      "mcpServers",
      "toolsets",
    ]);
  });

  it("catalog install invalidates servers, catalog, and toolsets", () => {
    expect(resourcesForMutation("mcp.installCatalog")).toEqual([
      "mcpServers",
      "mcpCatalog",
      "toolsets",
    ]);
  });

  it("env writes invalidate env config and gateway status", () => {
    expect(resourcesForMutation("env.set")).toEqual([
      "envConfig",
      "gatewayStatus",
    ]);
  });

  it("gateway restart invalidates the full post-restart set", () => {
    expect(resourcesForMutation("gateway.restart")).toEqual([
      "mcpServers",
      "toolsets",
      "skills",
      "gatewayStatus",
    ]);
  });
});

describe("AdminStateCache — set, invalidate, subscribe", () => {
  it("a never-loaded resource is stale; a set resource is fresh", () => {
    const cache = makeCache();
    expect(cache.isStale("skills")).toBe(true);
    cache.set("skills", [{ name: "pdf" }]);
    expect(cache.isStale("skills")).toBe(false);
    expect(cache.get("skills")).toEqual([{ name: "pdf" }]);
  });

  it("afterMutation invalidates exactly the mutation's resources", () => {
    const cache = makeCache();
    cache.set("skills", ["a"]);
    cache.set("toolsets", ["b"]);
    cache.set("mcpServers", ["c"]);

    cache.afterMutation("skill.toggle", "pdf");

    expect(cache.isStale("skills")).toBe(true);
    // Unrelated resources are NOT invalidated.
    expect(cache.isStale("toolsets")).toBe(false);
    expect(cache.isStale("mcpServers")).toBe(false);
  });

  it("notifies a resource subscriber on set and on invalidate", () => {
    const cache = makeCache();
    let hits = 0;
    const unsub = cache.subscribe("mcpServers", () => {
      hits += 1;
    });
    cache.set("mcpServers", []);
    cache.invalidate(["mcpServers"]);
    expect(hits).toBe(2);
    unsub();
    cache.invalidate(["mcpServers"]);
    expect(hits).toBe(2); // no longer notified after unsubscribe
  });

  it("bumps the resource version on every change so subscribers can refetch", () => {
    const cache = makeCache();
    const v0 = cache.versionOf("skills");
    cache.set("skills", []);
    cache.invalidate(["skills"]);
    expect(cache.versionOf("skills")).toBe(v0 + 2);
  });
});

describe("AdminStateCache — durable notifications", () => {
  it("raises a next-session notification on a skill toggle", () => {
    const cache = makeCache();
    cache.afterMutation("skill.toggle", "pdf");
    const notes = cache.getNotifications();
    expect(notes).toHaveLength(1);
    expect(notes[0].timing).toBe("next-session");
    expect(notes[0].message).toContain("New sessions");
    expect(notes[0].isError).toBeUndefined();
  });

  it("raises a restart-required notification on an MCP add", () => {
    const cache = makeCache();
    cache.afterMutation("mcp.add", "filesystem");
    const note = cache.getNotifications()[0];
    expect(note.timing).toBe("gateway-restart");
    expect(note.message).toContain("Restart Hermes gateway");
    expect(note.message).toContain("filesystem");
  });

  it("notifications carry no em/en-dashes", () => {
    const cache = makeCache();
    cache.afterMutation("skill.hubInstall", "research");
    cache.afterMutation("mcp.add", "linear");
    cache.afterMutation("env.set", "OPENAI_API_KEY");
    for (const note of cache.getNotifications()) {
      expect(note.message).not.toMatch(/[–—]/);
    }
  });

  it("afterAction on success invalidates and notifies; on failure raises an error note", () => {
    const cache = makeCache();
    cache.set("skills", ["a"]);

    const ok: HermesActionStatus = {
      action: "install-1",
      state: "succeeded",
      done: true,
      raw: {},
    };
    cache.afterAction("skill.hubInstall", "research", ok);
    expect(cache.isStale("skills")).toBe(true);
    expect(cache.getNotifications().at(-1)?.isError).toBeUndefined();

    const failed: HermesActionStatus = {
      action: "install-2",
      state: "failed",
      done: true,
      error: "Install blocked by security review.",
      raw: {},
    };
    cache.afterAction("skill.hubInstall", "evil-skill", failed);
    const errorNote = cache.getNotifications().at(-1);
    expect(errorNote?.isError).toBe(true);
    expect(errorNote?.message).toBe("Install blocked by security review.");
  });

  it("subscribers are notified when the notification list changes", () => {
    const cache = makeCache();
    const seen: number[] = [];
    cache.subscribeNotifications((notes) => seen.push(notes.length));
    cache.afterMutation("skill.toggle", "pdf");
    cache.dismissNotification(cache.getNotifications()[0].id);
    expect(seen).toEqual([1, 0]);
  });
});

describe("AdminStateCache — profile isolation", () => {
  it("keys resources by mode+profile so two caches cannot collide", () => {
    const sandboxedDefault = makeCache("default", { fullMode: false });
    const sandboxedWork = makeCache("work", { fullMode: false });

    sandboxedDefault.set("skills", ["default-skill"]);
    sandboxedWork.set("skills", ["work-skill"]);

    // Keys differ; the underlying entries do not leak across caches.
    expect(sandboxedDefault.keyFor("skills")).not.toBe(
      sandboxedWork.keyFor("skills"),
    );
    expect(sandboxedDefault.get<string[]>("skills")).toEqual(["default-skill"]);
    expect(sandboxedWork.get<string[]>("skills")).toEqual(["work-skill"]);
  });

  it("includes every declared resource in the key space", () => {
    const cache = makeCache();
    const resources: AdminResource[] = [
      "skills",
      "hubSearch",
      "toolsets",
      "mcpServers",
      "mcpCatalog",
      "profiles",
      "gatewayStatus",
      "actionStatus",
      "envConfig",
    ];
    const keys = new Set(resources.map((r) => cache.keyFor(r)));
    expect(keys.size).toBe(resources.length); // all distinct
  });
});
