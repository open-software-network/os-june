import { describe, expect, it } from "vitest";
import { modelPrivacyBadge } from "../lib/model-privacy";

describe("model privacy labels", () => {
  it("uses private mode for private models even when they are anonymized", () => {
    expect(
      modelPrivacyBadge({ privacy: "private", traits: ["anonymized"] }),
    ).toMatchObject({
      mode: "private",
      label: "Private mode",
      description: "You're using a model that is private and anonymous.",
    });
  });

  it("uses anonymous mode for anonymous-only models", () => {
    expect(
      modelPrivacyBadge({ privacy: "anonymous", traits: [] }),
    ).toMatchObject({
      mode: "anonymous",
      label: "Anonymous mode",
      description:
        "You're using a model that is anonymizing your prompts but may still train on your data.",
    });
  });

  it("does not label models without a privacy signal", () => {
    expect(modelPrivacyBadge({ privacy: "OpenAI", traits: ["prompt"] })).toBe(
      undefined,
    );
  });
});
