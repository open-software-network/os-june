import { describe, expect, it } from "vitest";
import {
  isAccessibilityBlocked,
  mergeMicOnlyFallbackReadiness,
  mergeNonProbingSourceReadiness,
} from "../app/App";
import type {
  RecordingSourceReadinessDto,
  SourceReadinessDto,
} from "../lib/tauri";

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

function microphoneSource(): SourceReadinessDto {
  return {
    source: "microphone",
    required: true,
    ready: true,
    permissionState: "granted",
    deviceAvailable: true,
    captureAvailable: true,
  };
}

function readiness(system: SourceReadinessDto): RecordingSourceReadinessDto {
  return {
    sourceMode: "microphonePlusSystem",
    ready: system.ready,
    sources: [microphoneSource(), system],
  };
}

describe("mergeNonProbingSourceReadiness", () => {
  it("preserves a denied system audio verdict across nonprompting refreshes", () => {
    const deniedSystem: SourceReadinessDto = {
      source: "system",
      required: true,
      ready: false,
      permissionState: "denied",
      deviceAvailable: true,
      captureAvailable: false,
      recoveryAction: "openSystemAudioSettings",
      message: "System audio is denied.",
    };
    const unknownSystem: SourceReadinessDto = {
      source: "system",
      required: true,
      ready: false,
      permissionState: "unknown",
      deviceAvailable: true,
      captureAvailable: true,
      recoveryAction: "openSystemAudioSettings",
    };

    const merged = mergeNonProbingSourceReadiness(
      readiness(deniedSystem),
      readiness(unknownSystem),
    );

    expect(merged.ready).toBe(false);
    expect(merged.sources.find((source) => source.source === "system")).toEqual(
      deniedSystem,
    );
  });

  it("keeps a fresh probing verdict when it is no longer unknown", () => {
    const deniedSystem: SourceReadinessDto = {
      source: "system",
      required: true,
      ready: false,
      permissionState: "denied",
      deviceAvailable: true,
      captureAvailable: false,
      recoveryAction: "openSystemAudioSettings",
    };
    const grantedSystem: SourceReadinessDto = {
      source: "system",
      required: true,
      ready: true,
      permissionState: "unknown",
      deviceAvailable: true,
      captureAvailable: true,
      recoveryAction: "openSystemAudioSettings",
    };

    const merged = mergeNonProbingSourceReadiness(
      readiness(deniedSystem),
      readiness(grantedSystem),
    );

    expect(merged.ready).toBe(true);
    expect(merged.sources.find((source) => source.source === "system")).toEqual(
      grantedSystem,
    );
  });
});

describe("mergeMicOnlyFallbackReadiness", () => {
  it("keeps a denied system audio verdict after a mic-only fallback check", () => {
    const deniedSystem: SourceReadinessDto = {
      source: "system",
      required: true,
      ready: false,
      permissionState: "denied",
      deviceAvailable: true,
      captureAvailable: false,
      recoveryAction: "openSystemAudioSettings",
    };
    const micOnly: RecordingSourceReadinessDto = {
      sourceMode: "microphoneOnly",
      ready: true,
      sources: [microphoneSource()],
    };

    const merged = mergeMicOnlyFallbackReadiness(
      readiness(deniedSystem),
      micOnly,
    );

    expect(merged.ready).toBe(false);
    expect(merged.sources.find((source) => source.source === "system")).toEqual(
      deniedSystem,
    );
  });

  it("keeps an unsupported system audio verdict after a mic-only fallback check", () => {
    const unsupportedSystem: SourceReadinessDto = {
      source: "system",
      required: true,
      ready: false,
      permissionState: "unsupported",
      deviceAvailable: false,
      captureAvailable: false,
      recoveryAction: "upgradeMacos",
    };
    const micOnly: RecordingSourceReadinessDto = {
      sourceMode: "microphoneOnly",
      ready: true,
      sources: [microphoneSource()],
    };

    const merged = mergeMicOnlyFallbackReadiness(
      readiness(unsupportedSystem),
      micOnly,
    );

    expect(merged.ready).toBe(false);
    expect(merged.sources.find((source) => source.source === "system")).toEqual(
      unsupportedSystem,
    );
  });

  it("does not add a system source when the prior system source was usable", () => {
    const usableSystem: SourceReadinessDto = {
      source: "system",
      required: true,
      ready: true,
      permissionState: "unknown",
      deviceAvailable: true,
      captureAvailable: true,
    };
    const micOnly: RecordingSourceReadinessDto = {
      sourceMode: "microphoneOnly",
      ready: true,
      sources: [microphoneSource()],
    };

    expect(
      mergeMicOnlyFallbackReadiness(readiness(usableSystem), micOnly),
    ).toBe(micOnly);
  });
});
