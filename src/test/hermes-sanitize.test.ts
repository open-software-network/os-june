import { describe, expect, it } from "vitest";
import { isSensitiveKey, sanitizePayload } from "../lib/hermes-control-plane";

describe("sanitizePayload — key-based redaction", () => {
  it("preserves a `value` field (common non-secret tool result, not a credential)", () => {
    // `value` was removed from the sensitive-key pattern: it over-redacted
    // ordinary tool results. The secret path (secret.request) never sends a raw
    // value through this redactor, so it is safe to keep `value`.
    const out = sanitizePayload({
      result: { value: 42 },
      numericValue: 100,
      value: "hello world",
    }) as Record<string, unknown>;
    expect(out.result).toEqual({ value: 42 });
    expect(out.numericValue).toBe(100);
    expect(out.value).toBe("hello world");
  });

  it("redacts passphrase / pin / otp regardless of value shape", () => {
    const out = sanitizePayload({
      passphrase: "open",
      pin: "00",
      otp: "999",
      note: "safe",
    }) as Record<string, unknown>;
    expect(out.passphrase).toBe("[redacted]");
    expect(out.pin).toBe("[redacted]");
    expect(out.otp).toBe("[redacted]");
    expect(out.note).toBe("safe");
  });

  it("still redacts genuinely sensitive keys; `value` is no longer sensitive", () => {
    expect(isSensitiveKey("value")).toBe(false);
    expect(isSensitiveKey("token")).toBe(true);
    expect(isSensitiveKey("secret")).toBe(true);
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("authorization")).toBe(true);
    expect(isSensitiveKey("apiKey")).toBe(true);
    expect(isSensitiveKey("credential")).toBe(true);
    expect(isSensitiveKey("passphrase")).toBe(true);
    expect(isSensitiveKey("pin")).toBe(true);
    expect(isSensitiveKey("otp")).toBe(true);
  });
});

describe("sanitizePayload — value-shape backstop exempts paths/urls", () => {
  it("preserves a long absolute file path under a benign key (not redacted)", () => {
    const path =
      "/Users/x/code/project/src/components/agent/VeryLongFileName.tsx";
    // Sanity: this is exactly the shape the old backstop would have masked
    // (single token, >31 chars) — the fix must let it through.
    expect(path.length).toBeGreaterThan(31);
    expect(path).not.toMatch(/\s/);
    const out = sanitizePayload({ path }) as Record<string, unknown>;
    expect(out.path).toBe(path);
  });

  it("preserves a long https URL under a benign key", () => {
    const url =
      "https://example.com/very/long/url/path/that/exceeds/thirty/one/characters";
    const out = sanitizePayload({ url }) as Record<string, unknown>;
    expect(out.url).toBe(url);
  });

  it("preserves a ~/ home path and a Windows drive path", () => {
    const out = sanitizePayload({
      home: "~/code/project/src/components/AgentWorkspace.tsx",
      win: "C:\\Users\\me\\code\\project\\src\\components\\Agent.tsx",
    }) as Record<string, unknown>;
    expect(out.home).toBe("~/code/project/src/components/AgentWorkspace.tsx");
    expect(out.win).toBe(
      "C:\\Users\\me\\code\\project\\src\\components\\Agent.tsx",
    );
  });

  it("STILL redacts a long opaque token (no separators) under a benign key", () => {
    const token = "Abcthough32charsNoSlashesXXXXXXyZ";
    expect(token.length).toBeGreaterThan(31);
    const out = sanitizePayload({ note: token }) as Record<string, unknown>;
    expect(out.note).toBe("[redacted]");
  });

  it("STILL redacts a bearer-prefixed value even though it has no separator", () => {
    const out = sanitizePayload({
      headers: "Bearer abc.def.ghi",
    }) as Record<string, unknown>;
    expect(out.headers).toBe("[redacted]");
  });

  it("key-based redaction STILL wins for a path-shaped secret under a sensitive key", () => {
    // A value that looks like a path but lives under `token`: the key match
    // must redact it regardless of the relaxed value-shape backstop.
    const out = sanitizePayload({
      token: "/Users/x/code/secret/with/slashes/and/a/long/path.txt",
    }) as Record<string, unknown>;
    expect(out.token).toBe("[redacted]");
  });
});

describe("sanitizePayload — cycle detection", () => {
  it("does NOT mislabel an object reachable by two sibling paths as [circular]", () => {
    // A shared (but acyclic) child reached from two siblings. The DAG must be
    // rendered in full on BOTH paths — its second occurrence is not a cycle.
    const shared = { label: "shared", n: 1 };
    const out = sanitizePayload({ a: shared, b: shared }) as Record<
      string,
      unknown
    >;
    expect(out.a).toEqual({ label: "shared", n: 1 });
    expect(out.b).toEqual({ label: "shared", n: 1 });
    expect(JSON.stringify(out)).not.toContain("[circular]");
  });

  it("does NOT mislabel a shared element appearing twice in an array", () => {
    const shared = { id: "x" };
    const out = sanitizePayload([shared, shared]) as unknown[];
    expect(out).toEqual([{ id: "x" }, { id: "x" }]);
    expect(JSON.stringify(out)).not.toContain("[circular]");
  });

  it("still breaks a genuine cycle with [circular]", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node; // a real back-reference up the ancestor chain
    const out = sanitizePayload(node) as Record<string, unknown>;
    expect(out.name).toBe("root");
    expect(out.self).toBe("[circular]");
  });

  it("breaks a deeper indirect cycle (a -> b -> a)", () => {
    const a: Record<string, unknown> = { tag: "a" };
    const b: Record<string, unknown> = { tag: "b" };
    a.child = b;
    b.parent = a;
    const out = sanitizePayload(a) as Record<string, unknown>;
    const child = out.child as Record<string, unknown>;
    expect(child.tag).toBe("b");
    // b points back up to its ancestor a — that IS a cycle.
    expect(child.parent).toBe("[circular]");
  });
});
