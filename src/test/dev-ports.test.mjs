import { describe, expect, it, vi } from "vitest";
import { chooseDevPort } from "../../scripts/dev-ports.mjs";

describe("development stack ports", () => {
  it("moves the local June API off a port owned by another worktree", async () => {
    const portIsFree = vi.fn(async (port) => port === 8082);

    await expect(
      chooseDevPort({ name: "June API", explicitValue: undefined, base: 8080, portIsFree }),
    ).resolves.toBe(8082);
    expect(portIsFree.mock.calls).toEqual([[8080], [8081], [8082]]);
  });

  it("fails instead of reusing an occupied explicit port", async () => {
    await expect(
      chooseDevPort({
        name: "June API",
        explicitValue: "8080",
        base: 8080,
        portIsFree: async () => false,
      }),
    ).rejects.toThrow("June API port 8080 is already in use");
  });
});
