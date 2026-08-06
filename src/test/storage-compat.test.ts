import { beforeEach, describe, expect, it } from "vitest";
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

  it("commits canonical storage before the rollback alias", () => {
    const writes: string[] = [];
    const write = (key: string) => {
      writes.push(key);
      if (key === "june:theme") throw new Error("legacy unavailable");
    };

    expect(() => writeCompatibleStorageValue(write, "clovy:theme", "june:theme", "dark")).toThrow(
      "legacy unavailable",
    );
    expect(writes).toEqual(["clovy:theme", "june:theme"]);

    writes.length = 0;
    expect(() =>
      writeCompatibleStorageValue(
        (key) => {
          writes.push(key);
          throw new Error("canonical unavailable");
        },
        "clovy:theme",
        "june:theme",
        "light",
      ),
    ).toThrow("canonical unavailable");
    expect(writes).toEqual(["clovy:theme"]);
  });
});
