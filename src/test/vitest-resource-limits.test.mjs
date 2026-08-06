import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Vitest resource limits", () => {
  it("keeps every frontend test command in a bounded worker-thread pool", () => {
    const configs = [
      readFileSync(resolve("vite.config.ts"), "utf8"),
      readFileSync(resolve("extension/vite.config.ts"), "utf8"),
    ];

    for (const config of configs) {
      const testConfig = config.slice(config.indexOf("  test: {"));
      expect(testConfig).toContain('pool: "threads"');
      expect(testConfig).toContain("fileParallelism: false");
      expect(testConfig).toContain("maxWorkers: 1");
    }
  });
});
