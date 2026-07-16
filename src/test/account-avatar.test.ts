import { describe, expect, it } from "vitest";
import {
  accountAvatarStyle,
  resolvedAccountAvatarSeed,
  supportedAccountAvatarSeed,
} from "../components/account/AccountAvatar";

describe("Open Software Avatar v1 contract", () => {
  it("accepts only supported printable v1 seeds", () => {
    expect(supportedAccountAvatarSeed("v1:0123456789abcdef")).toBe("v1:0123456789abcdef");
    expect(supportedAccountAvatarSeed(`v1:${"x".repeat(125)}`)).toHaveLength(128);
    expect(supportedAccountAvatarSeed("v1:")).toBeUndefined();
    expect(supportedAccountAvatarSeed("v2:future")).toBeUndefined();
    expect(supportedAccountAvatarSeed("v1:line\nbreak")).toBeUndefined();
    expect(supportedAccountAvatarSeed(`v1:${"x".repeat(126)}`)).toBeUndefined();
  });

  it("derives the canonical default without replacing an unsupported version", () => {
    expect(resolvedAccountAvatarSeed(undefined, "usr_123")).toBe("v1:default:usr_123");
    expect(resolvedAccountAvatarSeed("v2:future", "usr_123")).toBe("v1:default:usr_123");
  });

  it("matches the OS Accounts Avatar v1 geometry", () => {
    expect(accountAvatarStyle("v1:0123456789abcdef")).toEqual({
      "--avatar-cloud-x": "39%",
      "--avatar-cloud-y": "37%",
      "--avatar-cloud-angle": "192deg",
      "--avatar-cloud-strength": "65%",
    });
  });
});
