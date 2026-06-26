import { describe, expect, it } from "vitest";
import {
  getFeatureStatus,
  hermesCompatibilityMatrix,
  isHermesFeatureSupported,
  type HermesCompatibilityStatus,
} from "../lib/hermes-control-plane/compatibility";
import { PINNED_HERMES_VERSION } from "../lib/hermes-control-plane/compatibility";

const PIN = "v2026.6.19";

describe("hermes compatibility matrix — shape and pin", () => {
  it("pins the matrix to the current upstream Hermes version note", () => {
    expect(PINNED_HERMES_VERSION).toBe(PIN);
    expect(hermesCompatibilityMatrix.hermesVersion).toBe(PIN);
  });

  it("exposes the three tracked sections", () => {
    expect(hermesCompatibilityMatrix.methods).toBeTypeOf("object");
    expect(hermesCompatibilityMatrix.events).toBeTypeOf("object");
    expect(hermesCompatibilityMatrix.features).toBeTypeOf("object");
  });

  it("gives every matrix entry a status and a rationale", () => {
    const sections = [
      hermesCompatibilityMatrix.methods,
      hermesCompatibilityMatrix.events,
      hermesCompatibilityMatrix.features,
    ];
    const valid: HermesCompatibilityStatus[] = [
      "supported",
      "partial",
      "planned",
      "unsupported",
      "unknown",
    ];
    for (const section of sections) {
      for (const [key, entry] of Object.entries(section)) {
        expect(valid, `${key} status`).toContain(entry.status);
        expect(entry.rationale.length, `${key} rationale`).toBeGreaterThan(0);
      }
    }
  });
});

describe("hermes compatibility matrix — required keys", () => {
  it("tracks every control-plane method, including the confirmed baseline", () => {
    const methodKeys = Object.keys(hermesCompatibilityMatrix.methods);
    for (const required of [
      // Method stubs introduced by feature 01 (not yet UI-wired).
      "session.steer",
      "session.branch",
      "session.compress",
      "session.usage",
      "command.dispatch",
      "subagent.interrupt",
      "image.attach",
      "sudo.respond",
      "secret.respond",
      // Baseline methods June already calls today (grep-confirmed in
      // AgentWorkspace.tsx).
      "session.create",
      "prompt.submit",
      "session.interrupt",
      "session.active_list",
    ]) {
      expect(methodKeys, `methods.${required}`).toContain(required);
    }
  });

  it("tracks every classified event family", () => {
    const eventKeys = Object.keys(hermesCompatibilityMatrix.events);
    for (const required of [
      "message",
      "thinking",
      "tool",
      "approval",
      "clarify",
      "sudo",
      "secret",
      "subagent",
      "error",
      "lifecycle",
    ]) {
      expect(eventKeys, `events.${required}`).toContain(required);
    }
  });

  it("tracks the first-party feature surfaces", () => {
    const featureKeys = Object.keys(hermesCompatibilityMatrix.features);
    for (const required of [
      "backgroundSubagentWatch",
      "imageEditing",
      "automationBlueprints",
      "messagingIntegrations",
    ]) {
      expect(featureKeys, `features.${required}`).toContain(required);
    }
  });
});

describe("isHermesFeatureSupported — honest support gate", () => {
  it("returns true only for entries marked supported", () => {
    // message events both classify and render today.
    expect(isHermesFeatureSupported("message")).toBe(true);
    expect(isHermesFeatureSupported("tool")).toBe(true);
  });

  it("does not report planned surfaces as supported", () => {
    // Every control-plane method has now shipped UI, so the honest-gate example
    // is a product surface June has not built yet. automationBlueprints stays
    // planned → the gate must still report it false.
    expect(getFeatureStatus("automationBlueprints")).toBe("planned");
    expect(isHermesFeatureSupported("automationBlueprints")).toBe(false);
  });

  it("reports feature 19's image.attach + image editing once shipped", () => {
    // Feature 19 wires the composer's imported images into image.attach
    // (attachImage) with imported/attached/failed status, a failed-attach submit
    // block, and the attachment fed into feature 14's artifact timeline, so its
    // owned method key flips planned → supported; the imageEditing feature is
    // partial (explicit source-image selection ships; the edited output is not
    // rendered inline yet). Covered by hermes-image-attach and agent-workspace
    // tests.
    expect(getFeatureStatus("image.attach")).toBe("supported");
    expect(isHermesFeatureSupported("image.attach")).toBe(true);
    expect(getFeatureStatus("imageEditing")).toBe("partial");
    expect(isHermesFeatureSupported("imageEditing")).toBe(false);
  });

  it("reports feature 11's subagent activity as supported once shipped", () => {
    // Feature 11 ships the Agent activity drawer, which renders subagent.*
    // (background_activity) as a "Background work" phase + live subagent count
    // fed from hermesActivityStore, so its owned matrix key flips to supported.
    // Feature 12 (shared key) later deepens it into per-subagent rows.
    expect(getFeatureStatus("subagent")).toBe("supported");
    expect(isHermesFeatureSupported("subagent")).toBe(true);
  });

  it("reports feature 12's background subagent watch as supported once shipped", () => {
    // Feature 12 deepens the Agent activity drawer into per-subagent rows fed
    // from hermesActivityStore's subagents[] (start/progress/tool/thinking/
    // complete/error/blocked, UPSERTED by subagentId/handle), so both the shared
    // subagent event key and the backgroundSubagentWatch feature flip to
    // supported; covered by hermes-subagent-watch and agent-activity-drawer
    // tests.
    expect(getFeatureStatus("subagent")).toBe("supported");
    expect(isHermesFeatureSupported("subagent")).toBe(true);
    expect(getFeatureStatus("backgroundSubagentWatch")).toBe("supported");
    expect(isHermesFeatureSupported("backgroundSubagentWatch")).toBe(true);
  });

  it("reports feature 13's subagent.interrupt as supported once shipped", () => {
    // Feature 13 adds a per-subagent stop button to the Agent activity drawer's
    // background rows that calls interruptSubagent (subagent.interrupt) with the
    // row's trustworthy id/handle, confirms destructive (mid-tool) stops,
    // optimistically marks the subagent stopping, and reconciles from the event
    // stream; covered by hermes-subagent-interrupt tests. So its owned matrix
    // key flips from planned to supported.
    expect(getFeatureStatus("subagent.interrupt")).toBe("supported");
    expect(isHermesFeatureSupported("subagent.interrupt")).toBe(true);
  });

  it("reports feature 03's sudo/secret surfaces as supported once shipped", () => {
    // Feature 03 shipped the inline sudo/secret cards + typed responses, so its
    // four owned matrix keys are now supported, not partial/planned.
    expect(getFeatureStatus("sudo")).toBe("supported");
    expect(isHermesFeatureSupported("sudo")).toBe(true);
    expect(getFeatureStatus("secret")).toBe("supported");
    expect(isHermesFeatureSupported("secret")).toBe(true);
    expect(getFeatureStatus("sudo.respond")).toBe("supported");
    expect(isHermesFeatureSupported("sudo.respond")).toBe(true);
    expect(getFeatureStatus("secret.respond")).toBe("supported");
    expect(isHermesFeatureSupported("secret.respond")).toBe(true);
  });

  it("reports feature 10's command.dispatch as supported once shipped", () => {
    // Feature 10 wired switchActiveSessionModel (/model via command.dispatch)
    // into the composer model picker with tests, so its owned key flips to
    // supported.
    expect(getFeatureStatus("command.dispatch")).toBe("supported");
    expect(isHermesFeatureSupported("command.dispatch")).toBe(true);
  });

  it("reports feature 08's session.compress as supported once shipped", () => {
    // Feature 08 shipped the Compact context menu item + confirmation dialog
    // that calls compressSession, so its owned matrix key is now supported.
    expect(getFeatureStatus("session.compress")).toBe("supported");
    expect(isHermesFeatureSupported("session.compress")).toBe(true);
  });

  it("reports feature 07's session.branch as supported once shipped", () => {
    // Feature 07 shipped the per-message "Branch from here" action + typed
    // branchSession wiring, so its owned matrix key is now supported.
    expect(getFeatureStatus("session.branch")).toBe("supported");
    expect(isHermesFeatureSupported("session.branch")).toBe(true);
  });

  it("reports feature 06's session.steer as supported once shipped", () => {
    // Feature 06 shipped the busy-composer steer input that calls steerSession
    // (session.steer) and records the instruction as a transcript item, so its
    // owned matrix key flips from planned to supported.
    expect(getFeatureStatus("session.steer")).toBe("supported");
    expect(isHermesFeatureSupported("session.steer")).toBe(true);
  });

  it("treats an unknown feature as unknown, never supported", () => {
    expect(getFeatureStatus("nonexistent.thing")).toBe("unknown");
    expect(isHermesFeatureSupported("nonexistent.thing")).toBe(false);
  });

  it("returns false for a non-matching hermes version", () => {
    // A version that is not the current pin cannot be vouched for.
    expect(isHermesFeatureSupported("message", "v2026.6.5")).toBe(false);
    expect(getFeatureStatus("message", "v2026.6.5")).toBe("unknown");
  });

  it("honors the current pin when passed explicitly", () => {
    expect(isHermesFeatureSupported("message", PIN)).toBe(true);
    expect(getFeatureStatus("automationBlueprints", PIN)).toBe("planned");
  });
});
