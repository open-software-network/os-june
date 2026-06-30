import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PRIVACY_GUARD_MODE_CHANGED_EVENT,
  AGENT_PRIVACY_GUARD_MODE_KEY,
  agentPrivacyGuardNoticeMessage,
  createAgentPrivacyGuardSession,
  getAgentPrivacyGuardMode,
  protectAgentPromptText,
  setAgentPrivacyGuardMode,
  type AgentPrivacyGuardLoader,
} from "../lib/rampart-privacy";

describe("agent privacy guard", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to off and does not load Rampart", async () => {
    const loadGuard = vi.fn<AgentPrivacyGuardLoader>();

    const result = await protectAgentPromptText("Email ada@example.com", {
      loadGuard,
    });

    expect(result).toEqual({
      requestedMode: "off",
      mode: "off",
      text: "Email ada@example.com",
      placeholders: [],
      redacted: false,
    });
    expect(loadGuard).not.toHaveBeenCalled();
  });

  it("stores mode changes and dispatches a change event", () => {
    const events: string[] = [];
    window.addEventListener(AGENT_PRIVACY_GUARD_MODE_CHANGED_EVENT, (event) => {
      events.push(
        (event as CustomEvent<{ mode: string }>).detail?.mode ?? "missing",
      );
    });

    setAgentPrivacyGuardMode("structured");

    expect(window.localStorage.getItem(AGENT_PRIVACY_GUARD_MODE_KEY)).toBe(
      "structured",
    );
    expect(getAgentPrivacyGuardMode()).toBe("structured");
    expect(events).toEqual(["structured"]);

    setAgentPrivacyGuardMode("off");

    expect(
      window.localStorage.getItem(AGENT_PRIVACY_GUARD_MODE_KEY),
    ).toBeNull();
    expect(getAgentPrivacyGuardMode()).toBe("off");
    expect(events).toEqual(["structured", "off"]);
  });

  it("protects text through the selected guard mode", async () => {
    const loadGuard = vi.fn<AgentPrivacyGuardLoader>(async (mode) => ({
      mode,
      guard: {
        protect: async (text: string) => ({
          text: text.replace("ada@example.com", "[EMAIL_1]"),
          placeholders: ["[EMAIL_1]"],
        }),
      },
    }));

    const result = await protectAgentPromptText("Email ada@example.com", {
      mode: "structured",
      loadGuard,
    });

    expect(loadGuard).toHaveBeenCalledWith("structured");
    expect(result).toEqual({
      requestedMode: "structured",
      mode: "structured",
      text: "Email [EMAIL_1]",
      placeholders: ["[EMAIL_1]"],
      redacted: true,
    });
  });

  it("keeps placeholder state scoped to a guard session", async () => {
    const loadGuard = vi.fn<AgentPrivacyGuardLoader>(async (mode) => {
      const placeholdersByEmail = new Map<string, string>();
      return {
        mode,
        guard: {
          protect: async (text: string) => {
            const placeholders: string[] = [];
            const protectedText = text.replace(
              /[\w.-]+@[\w.-]+\.[a-z]+/gi,
              (email) => {
                let placeholder = placeholdersByEmail.get(email);
                if (!placeholder) {
                  placeholder = `[EMAIL_${placeholdersByEmail.size + 1}]`;
                  placeholdersByEmail.set(email, placeholder);
                }
                placeholders.push(placeholder);
                return placeholder;
              },
            );
            return { text: protectedText, placeholders };
          },
        },
      };
    });

    const firstSession = createAgentPrivacyGuardSession({ loadGuard });
    const secondSession = createAgentPrivacyGuardSession({ loadGuard });

    await expect(
      firstSession.protectText("Email ada@example.com", {
        mode: "structured",
      }),
    ).resolves.toMatchObject({ text: "Email [EMAIL_1]" });
    await expect(
      firstSession.protectText("Email grace@example.com", {
        mode: "structured",
      }),
    ).resolves.toMatchObject({ text: "Email [EMAIL_2]" });
    await expect(
      secondSession.protectText("Email ada@example.com", {
        mode: "structured",
      }),
    ).resolves.toMatchObject({ text: "Email [EMAIL_1]" });

    expect(loadGuard).toHaveBeenCalledTimes(2);
  });

  it("formats the redaction notice with singular and plural counts", () => {
    expect(agentPrivacyGuardNoticeMessage(1)).toBe(
      "Privacy guard redacted 1 detail before sending.",
    );
    expect(agentPrivacyGuardNoticeMessage(3)).toBe(
      "Privacy guard redacted 3 details before sending.",
    );
  });
});
