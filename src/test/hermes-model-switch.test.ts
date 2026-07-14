import { describe, expect, it, vi } from "vitest";
import { createHermesMethods } from "../lib/hermes-control-plane";
import {
  MODEL_SWITCH_DEFAULT_ONLY_NOTICE,
  MODEL_SWITCH_NEXT_MESSAGE_NOTICE,
} from "../lib/hermes-model-switch";

describe("switchActiveSessionModel — typed control-plane seam", () => {
  it("sets the model only on the active session", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const methods = createHermesMethods(request);

    await methods.switchActiveSessionModel({
      mode: "sandboxed",
      sessionId: "sess-1",
      model: "kimi-k2-6",
    });

    // config.set is Hermes' model mutation RPC. The session flag prevents the
    // switch from changing the runtime's global model default.
    expect(request).toHaveBeenCalledWith("config.set", {
      session_id: "sess-1",
      key: "model",
      value: "kimi-k2-6 --session",
      confirm_expensive_model: true,
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
    const notices = [MODEL_SWITCH_DEFAULT_ONLY_NOTICE, MODEL_SWITCH_NEXT_MESSAGE_NOTICE];
    for (const notice of notices) {
      expect(notice).not.toMatch(/[–—]/);
    }
  });

  it("distinguishes new-session defaults from next-message session changes", () => {
    expect(MODEL_SWITCH_DEFAULT_ONLY_NOTICE).toBe(
      "Default model updated. It applies to new sessions.",
    );
    expect(MODEL_SWITCH_NEXT_MESSAGE_NOTICE).toBe(
      "Model changed. It will be used for your next message.",
    );
  });
});
