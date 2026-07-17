import { describe, expect, it } from "vitest";
import { isAccessibilityBlocked, isMicrophoneRecordingBlocked } from "../app/App";
import type { RecordingSourceReadinessDto, SourceReadinessDto } from "../lib/tauri";

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

// JUN-185: the helper now polls AXIsProcessTrusted() and re-emits
// permission_status on change. The app maps each emitted status through
// isAccessibilityBlocked, so this guards the granted/missing/granted mapping
// used by the banner without exercising the full IPC event pipeline.
describe("accessibility banner across proactive status changes", () => {
  it("maps revoke and re-grant status changes to banner visibility", () => {
    // Trusted at launch: no banner.
    expect(isAccessibilityBlocked("granted")).toBe(false);
    // Grant revoked in System Settings mid-session (helper timer/wake poll
    // re-emits): banner appears with no dictation attempt.
    expect(isAccessibilityBlocked("missing")).toBe(true);
    // Re-granted (next change event): banner clears.
    expect(isAccessibilityBlocked("granted")).toBe(false);
  });
});

// TCC grants are bundle-scoped, so the dictation helper and main app can report
// different microphone states. Note recording follows the main app readiness
// probe once it is available; the helper is only a launch-time fallback.
function readinessWithMicPermission(
  permissionState: SourceReadinessDto["permissionState"],
): RecordingSourceReadinessDto {
  const microphone: SourceReadinessDto = {
    source: "microphone",
    required: true,
    ready: permissionState === "granted",
    permissionState,
    deviceAvailable: true,
    captureAvailable: permissionState === "granted",
  };
  return { sourceMode: "microphoneOnly", ready: microphone.ready, sources: [microphone] };
}

describe("isMicrophoneRecordingBlocked", () => {
  it("blocks when the readiness probe sees the main app's grant denied", () => {
    expect(isMicrophoneRecordingBlocked("granted", readinessWithMicPermission("denied"))).toBe(
      true,
    );
    expect(isMicrophoneRecordingBlocked(undefined, readinessWithMicPermission("restricted"))).toBe(
      true,
    );
  });

  it("uses the dictation helper before the main app readiness probe returns", () => {
    expect(isMicrophoneRecordingBlocked("denied", undefined)).toBe(true);
  });

  it("does not let a dictation-helper denial override a granted recorder", () => {
    expect(isMicrophoneRecordingBlocked("restricted", readinessWithMicPermission("granted"))).toBe(
      false,
    );
  });

  it("does not block when both signals are granted", () => {
    expect(isMicrophoneRecordingBlocked("granted", readinessWithMicPermission("granted"))).toBe(
      false,
    );
  });

  it("keeps a fresh install startable so the TCC prompt can fire", () => {
    // `unknown` covers the Rust probe's not_determined mapping; the start
    // path resolves it with the main app's own TCC prompt.
    expect(isMicrophoneRecordingBlocked(undefined, readinessWithMicPermission("unknown"))).toBe(
      false,
    );
    expect(isMicrophoneRecordingBlocked(undefined, undefined)).toBe(false);
  });
});
