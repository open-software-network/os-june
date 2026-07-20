import { describe, expect, it } from "vitest";
import {
  canCreateProfile,
  nextCopyProfileName,
  nextNumberedProfileName,
  profileNameCollides,
  slugifyProfileName,
  validateProfileName,
} from "../lib/hermes-admin";

describe("profile names", () => {
  it("slugifies a free-text name to a safe slug", () => {
    expect(slugifyProfileName("Research Assistant!")).toBe("research-assistant");
    expect(slugifyProfileName("  My/Agent 2  ")).toBe("my-agent-2");
    expect(slugifyProfileName("***")).toBe("");
  });

  it("rejects empty, reserved, and colliding names", () => {
    expect(validateProfileName("", [])).toMatch(/enter a profile name/i);
    expect(validateProfileName("***", [])).toMatch(/letters or numbers/i);
    expect(validateProfileName("default", [])).toMatch(/reserved/i);
    expect(validateProfileName("Research", [{ name: "research", raw: {} }])).toMatch(
      /already exists/i,
    );
    expect(canCreateProfile("Research", [{ name: "research", raw: {} }])).toBe(false);
  });

  it("checks both names and slugs for collisions", () => {
    const profiles = [{ name: "client-work", raw: {} }];
    expect(profileNameCollides("Client work", profiles)).toBe(true);
    expect(profileNameCollides("Client notes", profiles)).toBe(false);
  });

  it("returns the first free numbered profile name", () => {
    expect(nextNumberedProfileName([{ name: "default", raw: {} }])).toBe("Profile 2");
    expect(
      nextNumberedProfileName([
        { name: "default", raw: {} },
        { name: "profile-2", raw: {} },
      ]),
    ).toBe("Profile 3");
  });

  it("bumps a colliding copy name", () => {
    expect(
      nextCopyProfileName("Client work", [
        { name: "client-work", raw: {} },
        { name: "client-work-copy", raw: {} },
      ]),
    ).toBe("Client work copy 2");
  });
});
