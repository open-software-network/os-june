import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Regression guard for JUN-355: on Nodes that ship an unavailable Web Storage
// global (24/26), the setup.ts shim replaces jsdom's Storage. These assertions
// hold for a real Storage and must keep holding for the shim, so tests that
// enumerate or spy on storage behave identically on every Node.
describe("test-global localStorage is spec-faithful", () => {
  // setup.ts pre-seeds the onboarding-complete key in a global beforeEach;
  // start each test from an empty store so counts are deterministic.
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("exposes stored keys, not methods, to Object.keys", () => {
    localStorage.setItem("spec-probe.alpha", "1");
    localStorage.setItem("spec-probe.beta", "2");

    const keys = Object.keys(localStorage);
    expect(keys).toContain("spec-probe.alpha");
    expect(keys).toContain("spec-probe.beta");
    expect(keys).not.toContain("getItem");
    expect(keys).not.toContain("setItem");
    expect(keys).not.toContain("clear");
  });

  it("enumerates via length and key(i)", () => {
    localStorage.setItem("spec-probe.alpha", "1");
    localStorage.setItem("spec-probe.beta", "2");

    expect(localStorage.length).toBe(2);
    const keys = [localStorage.key(0), localStorage.key(1)].sort();
    expect(keys).toEqual(["spec-probe.alpha", "spec-probe.beta"]);
    expect(localStorage.key(2)).toBeNull();
  });

  it("never lets a method-named key shadow the interface member", () => {
    localStorage.setItem("getItem", "x");

    // WebIDL named-property semantics: the method stays callable, the value
    // is retrievable via getItem, and the key is hidden from enumeration.
    expect(typeof localStorage.getItem).toBe("function");
    expect(localStorage.getItem("getItem")).toBe("x");
    expect(Object.keys(localStorage)).not.toContain("getItem");

    localStorage.removeItem("getItem");
    expect(localStorage.getItem("getItem")).toBeNull();
  });

  it("round-trips items and clears", () => {
    localStorage.setItem("spec-probe.alpha", "value");
    expect(localStorage.getItem("spec-probe.alpha")).toBe("value");
    expect(localStorage.getItem("spec-probe.missing")).toBeNull();

    localStorage.removeItem("spec-probe.alpha");
    expect(localStorage.getItem("spec-probe.alpha")).toBeNull();

    localStorage.setItem("spec-probe.beta", "1");
    localStorage.clear();
    expect(localStorage.length).toBe(0);
  });
});
