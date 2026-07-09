import { describe, expect, it } from "vitest";
import { mergeSourceReadiness, systemAudioAvailability } from "../lib/source-readiness";
import type { RecordingSourceReadinessDto, SourceReadinessDto } from "../lib/tauri";

function microphone(): SourceReadinessDto {
  return {
    source: "microphone",
    required: true,
    ready: true,
    permissionState: "granted",
    deviceAvailable: true,
    captureAvailable: true,
  };
}

function system(overrides: Partial<SourceReadinessDto>): SourceReadinessDto {
  return {
    source: "system",
    required: false,
    ready: false,
    permissionState: "unknown",
    deviceAvailable: false,
    captureAvailable: false,
    ...overrides,
  };
}

function readiness(
  sourceMode: RecordingSourceReadinessDto["sourceMode"],
  sources: SourceReadinessDto[],
): RecordingSourceReadinessDto {
  return { sourceMode, ready: true, sources };
}

describe("systemAudioAvailability", () => {
  it("is unknown until the probe answers", () => {
    expect(systemAudioAvailability(undefined)).toBe("unknown");
  });

  it("is unsupported when the payload omits the system source", () => {
    expect(systemAudioAvailability(readiness("microphoneOnly", [microphone()]))).toBe(
      "unsupported",
    );
  });

  it.each([
    {
      name: "below macOS 14.2",
      overrides: { permissionState: "unsupported" as const },
      expected: "unsupported",
    },
    {
      name: "the user declined",
      overrides: { permissionState: "denied" as const },
      expected: "denied",
    },
    {
      name: "policy restricts it",
      overrides: { permissionState: "restricted" as const },
      expected: "denied",
    },
    {
      name: "granted but the capture is unavailable",
      overrides: { permissionState: "granted" as const, ready: false },
      expected: "unavailable",
    },
    {
      name: "granted and capturable",
      overrides: { permissionState: "granted" as const, ready: true },
      expected: "usable",
    },
    {
      // Capable but unprobed stays offerable, so turning the switch on can fire
      // the permission probe.
      name: "capable but never probed",
      overrides: { permissionState: "unknown" as const, ready: true },
      expected: "usable",
    },
  ])("is $expected when $name", ({ overrides, expected }) => {
    const payload = readiness("microphonePlusSystem", [microphone(), system(overrides)]);

    expect(systemAudioAvailability(payload)).toBe(expected);
  });
});

describe("mergeSourceReadiness", () => {
  it("keeps a denied verdict when a microphone-only check reports the Mac as capable", () => {
    const previous = readiness("microphonePlusSystem", [
      microphone(),
      system({ required: true, permissionState: "denied" }),
    ]);
    // A microphone-only probe skips the helper preflight, so `ready` here means
    // "this Mac is capable", never "the permission was granted".
    const next = readiness("microphoneOnly", [
      microphone(),
      system({ ready: true, captureAvailable: true, deviceAvailable: true }),
    ]);

    const merged = mergeSourceReadiness(previous, next);
    const merged_system = merged.sources.find((source) => source.source === "system");

    expect(merged_system?.permissionState).toBe("denied");
    expect(merged_system?.ready).toBe(false);
    expect(merged_system?.required).toBe(false);
  });

  it("takes a microphone-plus-system payload verbatim", () => {
    const previous = readiness("microphonePlusSystem", [
      microphone(),
      system({ required: true, ready: true, permissionState: "granted" }),
    ]);
    const next = readiness("microphonePlusSystem", [
      microphone(),
      system({ required: true, permissionState: "denied" }),
    ]);

    const merged = mergeSourceReadiness(previous, next);

    expect(merged.sources.find((source) => source.source === "system")?.permissionState).toBe(
      "denied",
    );
  });

  it("falls back to the microphone-only payload when nothing was assessed yet", () => {
    const next = readiness("microphoneOnly", [
      microphone(),
      system({ permissionState: "unsupported" }),
    ]);

    const merged = mergeSourceReadiness(undefined, next);

    expect(merged.sources.find((source) => source.source === "system")?.permissionState).toBe(
      "unsupported",
    );
  });

  it("never reports a grant from an unassessed capable Mac", () => {
    // Recording can start before the mount-time probe answers, so nothing has
    // been assessed yet and the payload carries capability, not a verdict.
    const next = readiness("microphoneOnly", [
      microphone(),
      system({ ready: true, captureAvailable: true, deviceAvailable: true }),
    ]);

    const merged = mergeSourceReadiness(undefined, next);
    const mergedSystem = merged.sources.find((source) => source.source === "system");

    expect(mergedSystem?.ready).toBe(true);
    expect(mergedSystem?.permissionState).not.toBe("granted");
  });
});
