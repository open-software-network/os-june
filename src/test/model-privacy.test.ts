import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_MODEL_DESCRIPTION,
  E2EE_MODEL_DESCRIPTION,
  PRIVATE_MODEL_DESCRIPTION,
  modelPrivacyBadge,
} from "../lib/model-privacy";

describe("model privacy labels", () => {
  it("uses e2ee mode over private — the stronger claim wins", () => {
    expect(
      modelPrivacyBadge({
        privacy: "private",
        traits: [],
        capabilities: ["e2ee"],
      }),
    ).toMatchObject({
      mode: "e2ee",
      label: "E2EE",
      description: E2EE_MODEL_DESCRIPTION,
    });
  });

  it("reads the e2ee signal from privacy, traits, or capabilities", () => {
    expect(modelPrivacyBadge({ privacy: "e2ee", traits: [] })?.mode).toBe(
      "e2ee",
    );
    expect(modelPrivacyBadge({ privacy: "", traits: ["e2ee"] })?.mode).toBe(
      "e2ee",
    );
    expect(
      modelPrivacyBadge({ privacy: "", traits: [], capabilities: ["E2EE"] })
        ?.mode,
    ).toBe("e2ee");
  });

  it("uses private mode for private models even when they are anonymized", () => {
    expect(
      modelPrivacyBadge({ privacy: "private", traits: ["anonymized"] }),
    ).toMatchObject({
      mode: "private",
      label: "Private mode",
      description: PRIVATE_MODEL_DESCRIPTION,
    });
  });

  it("uses anonymous mode for anonymous-only models", () => {
    expect(
      modelPrivacyBadge({ privacy: "anonymous", traits: [] }),
    ).toMatchObject({
      mode: "anonymous",
      label: "Anonymous mode",
      description: ANONYMOUS_MODEL_DESCRIPTION,
    });
  });

  it("does not label models without a privacy signal", () => {
    expect(modelPrivacyBadge({ privacy: "OpenAI", traits: ["prompt"] })).toBe(
      undefined,
    );
  });
});
