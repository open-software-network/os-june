import { describe, expect, it } from "vitest";
import { isContextOverflowError } from "../lib/hermes-context-overflow";
import { HermesGatewayError } from "../lib/hermes-gateway";

describe("isContextOverflowError", () => {
  it("detects prompt.submit rejections", () => {
    expect(
      isContextOverflowError(
        new HermesGatewayError(
          "prompt_too_long: the request exceeds the model's maximum context length",
          400,
        ),
      ),
    ).toBe(true);
  });

  it("detects nested Hermes event payloads", () => {
    expect(
      isContextOverflowError({
        type: "error",
        payload: {
          response: {
            body: JSON.stringify({
              error: {
                error_code: 2001,
                message: "This model's maximum context window was exceeded.",
              },
            }),
          },
        },
      }),
    ).toBe(true);
  });

  it("detects stringified error objects", () => {
    expect(
      isContextOverflowError({
        payload: {
          error: '{"error_code":2001,"message":"context length exceeded"}',
        },
      }),
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(
      isContextOverflowError({
        type: "error",
        payload: { message: "session busy" },
      }),
    ).toBe(false);
  });
});
