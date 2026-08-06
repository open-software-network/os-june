import { beforeEach, describe, expect, it, vi } from "vitest";
import { legacyStorageKey, writeCompatibleStorageValue } from "../lib/storage-compat";

describe("Clovy browser-storage compatibility bridge", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("copies a June-era preference on first Clovy read without deleting it", () => {
    window.localStorage.setItem("june:theme", "dark");

    expect(window.localStorage.getItem("clovy:theme")).toBe("dark");
    expect(window.localStorage.getItem("june:theme")).toBe("dark");
    expect(window.localStorage.getItem("clovy:theme")).toBe("dark");
  });

  it("dual-writes and dual-deletes rollback-sensitive preferences", () => {
    window.localStorage.setItem("os-clovy:font-scale", "large");

    expect(window.localStorage.getItem("os-clovy:font-scale")).toBe("large");
    expect(window.localStorage.getItem("os-june:font-scale")).toBe("large");

    window.localStorage.removeItem("os-clovy:font-scale");
    expect(window.localStorage.getItem("os-clovy:font-scale")).toBeNull();
    expect(window.localStorage.getItem("os-june:font-scale")).toBeNull();
  });

  it("keeps a preference changed by a rollback build", () => {
    window.localStorage.setItem("clovy:theme", "dark");

    // A June-era build only knows the legacy key.
    window.localStorage.setItem("june:theme", "light");

    expect(window.localStorage.getItem("clovy:theme")).toBe("light");
    expect(window.localStorage.getItem("june:theme")).toBe("light");
  });

  it("keeps the rollback value when both sides diverge after an interrupted write", () => {
    window.localStorage.setItem("clovy:theme", "dark");

    // Clovy published to the rollback-readable side, then stopped before the
    // canonical write. A rollback build subsequently changed that side again.
    window.localStorage.setItem("june:theme", "staged-by-clovy");
    window.localStorage.setItem("june:theme", "changed-during-rollback");

    expect(window.localStorage.getItem("clovy:theme")).toBe("changed-during-rollback");
    expect(window.localStorage.getItem("june:theme")).toBe("changed-during-rollback");
  });

  it("loads a June-era active partition before module-level state is captured", async () => {
    window.localStorage.setItem("june:active-agent-profile", "work");
    vi.resetModules();

    const partition = await import("../lib/data-partition");

    expect(partition.getCurrentDataPartitionName()).toBe("work");
    expect(window.localStorage.getItem("clovy:active-agent-profile")).toBe("work");
  });

  it("keeps a preference deletion made by a rollback build", () => {
    window.localStorage.setItem("clovy:theme", "dark");

    // A June-era build only removes the legacy key.
    window.localStorage.removeItem("june:theme");

    expect(window.localStorage.getItem("clovy:theme")).toBeNull();
    expect(window.localStorage.getItem("june:theme")).toBeNull();
  });

  it("uses the same bridge for session storage", () => {
    window.sessionStorage.setItem("clovy:agent:new-session-pending", "session-1");

    expect(window.sessionStorage.getItem("june:agent:new-session-pending")).toBe("session-1");
  });

  it("does not alias unrelated application keys", () => {
    expect(legacyStorageKey("other:theme")).toBeUndefined();
    window.localStorage.setItem("other:theme", "dark");
    expect(window.localStorage.length).toBe(1);
  });

  it("publishes rollback storage before canonical storage", () => {
    const writes: string[] = [];
    const write = (key: string) => {
      writes.push(key);
      if (key === "clovy:theme") throw new Error("canonical unavailable");
    };

    expect(() => writeCompatibleStorageValue(write, "clovy:theme", "june:theme", "dark")).toThrow(
      "canonical unavailable",
    );
    expect(writes).toEqual(["june:theme", "clovy:theme"]);

    writes.length = 0;
    expect(() =>
      writeCompatibleStorageValue(
        (key) => {
          writes.push(key);
          throw new Error("legacy unavailable");
        },
        "clovy:theme",
        "june:theme",
        "light",
      ),
    ).toThrow("legacy unavailable");
    expect(writes).toEqual(["june:theme"]);
  });
});
