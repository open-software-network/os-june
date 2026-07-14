import { describe, expect, it } from "vitest";
import { chunkBytes, TaskTabRegistry } from "../browser";

describe("task tab registry", () => {
  it("refuses tabs outside the broker session", () => {
    const registry = new TaskTabRegistry();
    registry.start("session-a");
    registry.add("session-a", 10);
    expect(() => registry.tab("session-a", 11)).toThrow(/not owned/);
    expect(() => registry.tab("session-b", 10)).toThrow(/not found/);
  });

  it("expires snapshot refs on navigation or mutation", () => {
    const registry = new TaskTabRegistry();
    registry.start("session-a");
    registry.add("session-a", 10);
    expect(registry.setRefs("session-a", 10, 0, ["e0:n20"])).toBe(true);
    expect(registry.acceptsRef("session-a", 10, "e0:n20")).toBe(true);
    expect(registry.invalidate("session-a", 10)).toBe(1);
    expect(registry.acceptsRef("session-a", 10, "e0:n20")).toBe(false);
    expect(registry.setRefs("session-a", 10, 0, ["e0:n20"])).toBe(false);
  });

  it("plans disconnect cleanup using owned tabs only", () => {
    const registry = new TaskTabRegistry();
    registry.start("one");
    registry.start("two");
    registry.add("one", 1);
    registry.add("two", 2);
    expect(registry.cleanupPlan().sort()).toEqual([1, 2]);
  });
});

describe("native payload chunking", () => {
  it("keeps chunks well below the native frame limit and roundtrips bytes", () => {
    const input = Uint8Array.from({ length: 700_000 }, (_, index) => index % 251);
    const chunks = chunkBytes(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThan(512 * 1024);
    const output = chunks.flatMap((chunk) => [
      ...Uint8Array.from(atob(chunk), (value) => value.charCodeAt(0)),
    ]);
    expect(Uint8Array.from(output)).toEqual(input);
  });
});
