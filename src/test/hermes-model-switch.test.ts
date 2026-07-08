import { describe, expect, it, vi } from "vitest";
import { createHermesMethods } from "../lib/hermes-control-plane";
import {
  MODEL_CHANGE_LOCKED_NOTICE,
  MODEL_SWITCH_DEFAULT_ONLY_NOTICE,
} from "../lib/hermes-model-switch";

describe("switchActiveSessionModel — typed control-plane seam", () => {
  it("dispatches the /model slash command to the active session", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const methods = createHermesMethods(request);

    await methods.switchActiveSessionModel({
      mode: "sandboxed",
      sessionId: "sess-1",
      model: "kimi-k2-6",
    });

    // It must route through command.dispatch as `/model <model>`, never a
    // bespoke model.switch request — the gateway ack is our source of truth.
    expect(request).toHaveBeenCalledWith("command.dispatch", {
      session_id: "sess-1",
      command: "/model kimi-k2-6",
    });
  });

  it("returns the gateway result so the caller can confirm the ack", async () => {
    const request = vi.fn(async () => ({ accepted: true }));
    const methods = createHermesMethods(request);

    const result = await methods.switchActiveSessionModel({
      mode: "unrestricted",
      sessionId: "sess-2",
      model: "glm-5-2",
    });

    expect(result).toEqual({ accepted: true });
  });
});

describe("composer model notices", () => {
  it("copy carries no em or en dashes", () => {
    const notices = [MODEL_SWITCH_DEFAULT_ONLY_NOTICE, MODEL_CHANGE_LOCKED_NOTICE];
    for (const notice of notices) {
      expect(notice).not.toMatch(/[–—]/);
    }
  });

  it("distinguishes new-session defaults from locked existing threads", () => {
    expect(MODEL_SWITCH_DEFAULT_ONLY_NOTICE).toBe(
      "Default model updated. It applies to new sessions.",
    );
    expect(MODEL_CHANGE_LOCKED_NOTICE).toBe("Start a new session to change models.");
  });
});
