import { beforeEach, describe, expect, it } from "vitest";
import { legacyStorageKey } from "../lib/storage-compat";

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

  it("uses the same bridge for session storage", () => {
    window.sessionStorage.setItem("clovy:agent:new-session-pending", "session-1");

    expect(window.sessionStorage.getItem("june:agent:new-session-pending")).toBe("session-1");
  });

  it("does not alias unrelated application keys", () => {
    expect(legacyStorageKey("other:theme")).toBeUndefined();
    window.localStorage.setItem("other:theme", "dark");
    expect(window.localStorage.length).toBe(1);
  });
});
