import { describe, expect, it } from "vitest";
import { isAccessibilityBlocked } from "../app/App";

// Regression: the dictation helper reports Accessibility as "granted" |
// "missing" (AXIsProcessTrusted), not the microphone's denied/restricted
// vocabulary. A fresh install reports "missing", and that MUST count as
// blocked so the paste-permission banner shows — otherwise dictation
// silently fails to paste into other apps (Cmd+V needs the helper trusted).
describe("isAccessibilityBlocked", () => {
  it("treats a fresh-install 'missing' grant as blocked", () => {
    expect(isAccessibilityBlocked("missing")).toBe(true);
  });

  it("does not block once Accessibility is granted", () => {
    expect(isAccessibilityBlocked("granted")).toBe(false);
  });

  it("stays non-blocking before the helper's first report", () => {
    expect(isAccessibilityBlocked(undefined)).toBe(false);
  });

  it("treats any other non-granted status as blocked", () => {
    expect(isAccessibilityBlocked("denied")).toBe(true);
    expect(isAccessibilityBlocked("restricted")).toBe(true);
  });
});
