import { describe, expect, it } from "vitest";
import {
  isSensitiveKey,
  sanitizePayload,
  sanitizeText,
} from "../lib/hermes-control-plane";

describe("sanitizePayload — key-based redaction", () => {
  it("redacts a SHORT value under `value` (the literal key secret/sudo responses use)", () => {
    // Too short for the value-shape heuristic; only the key match catches it.
    const out = sanitizePayload({ request_id: "r1", value: "1234" }) as Record<
      string,
      unknown
    >;
    expect(out.value).toBe("[redacted]");
    // Non-sensitive siblings are untouched.
    expect(out.request_id).toBe("r1");
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

  it("treats the new keys as sensitive via isSensitiveKey", () => {
    expect(isSensitiveKey("value")).toBe(true);
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

  it("redacts sensitive query params in a URL under a benign key", () => {
    const out = sanitizePayload({
      url: "https://example.com/callback?key=plain-api-key-123&token=secret-token-123&view=1",
    }) as Record<string, unknown>;

    expect(out.url).toContain("view=1");
    expect(out.url).toContain("key=");
    expect(out.url).toContain("token=");
    expect(out.url).not.toContain("plain-api-key-123");
    expect(out.url).not.toContain("secret-token-123");
  });

  it("redacts URL credentials under a benign key", () => {
    const out = sanitizePayload({
      url: "https://user:supersecret@example.com/private",
    }) as Record<string, unknown>;

    expect(out.url).toContain("example.com/private");
    expect(out.url).not.toContain("user");
    expect(out.url).not.toContain("supersecret");
  });

  it("redacts token substrings inside a standalone URL", () => {
    const jwt = "eyJaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc";
    const artifactPath =
      "/tmp/artifacts/1234567890abcdef1234567890abcdef12345678.png";
    const out = sanitizePayload({
      pathUrl: "https://api.example.com/sk-abcdefghijklmnopqrstuvwxyz123456",
      callbackUrl: `https://host.example/callback?code=${jwt}&view=1`,
      hashUrl: "https://host.example/callback#access_token=abc123&state=ok",
      relativeUrl: "/callback?key=short-secret&view=1",
      artifactPath,
    }) as Record<string, unknown>;

    expect(out.pathUrl).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(out.callbackUrl).toContain("view=1");
    expect(out.callbackUrl).not.toContain(jwt);
    expect(out.hashUrl).toContain("state=ok");
    expect(out.hashUrl).not.toContain("abc123");
    expect(out.relativeUrl).toContain("view=1");
    expect(out.relativeUrl).not.toContain("short-secret");
    expect(out.artifactPath).toBe(artifactPath);
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

describe("sanitizeText", () => {
  it("redacts embedded bearer tokens and secret-looking values", () => {
    const text =
      "Request failed with Bearer abcdef0123456789abcdef0123456789, sk-abcdefghijklmnopqrstuvwxyz123456, and opaque-token-value-987654321";

    const out = sanitizeText(text);

    expect(out).toContain("Request failed");
    expect(out).toContain("Bearer [redacted]");
    expect(out).not.toContain("abcdef0123456789abcdef0123456789");
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(out).not.toContain("opaque-token-value-987654321");
  });

  it("redacts generic opaque tokens before sentence periods without breaking artifact paths", () => {
    const token = "a".repeat(40);
    const artifactId = "1234567890abcdef1234567890abcdef12345678";
    const out = sanitizeText(
      `Request failed with ${token}. Artifact at /tmp/artifacts/${artifactId}.png.`,
    );

    expect(out).toContain("[redacted].");
    expect(out).not.toContain(token);
    expect(out).toContain(`/tmp/artifacts/${artifactId}.png`);
  });

  it("redacts opaque tokens in sensitive absolute URL paths without breaking filesystem paths", () => {
    const urlToken = "b".repeat(40);
    const artifactId = "1234567890abcdef1234567890abcdef12345678";
    const out = sanitizeText(
      `Download https://files.example/download/${urlToken}?view=1 and inspect /tmp/artifacts/${artifactId}.png`,
    );

    expect(out).toContain("https://files.example/download/[redacted]?view=1");
    expect(out).not.toContain(urlToken);
    expect(out).toContain(`/tmp/artifacts/${artifactId}.png`);
  });

  it("redacts opaque tokens after compound sensitive URL path segments", () => {
    const resetToken = "c".repeat(40);
    const out = sanitizeText(
      `Reset at https://app.example/reset-password/${resetToken}?view=1 or https://app.example/password_reset/${resetToken}.`,
    );

    expect(out).toContain("https://app.example/reset-password/[redacted]");
    expect(out).toContain("https://app.example/password_reset/[redacted]");
    expect(out).not.toContain(resetToken);
  });

  it("redacts 32-character opaque tokens in sensitive absolute URL paths", () => {
    const resetToken = "d".repeat(32);
    const out = sanitizeText(
      `Reset at https://app.example/reset-password/${resetToken}?view=1`,
    );

    expect(out).toContain("https://app.example/reset-password/[redacted]");
    expect(out).not.toContain(resetToken);
  });

  it("redacts opaque tokens in relative sensitive URL paths", () => {
    const resetToken = "e".repeat(40);
    const shareToken = "f".repeat(32);
    const out = sanitizeText(
      `Request failed: GET /reset-password/${resetToken}?view=1 and ./share/${shareToken}.`,
    );

    expect(out).toContain("GET /reset-password/[redacted]?view=1");
    expect(out).toContain("./share/[redacted]");
    expect(out).not.toContain(resetToken);
    expect(out).not.toContain(shareToken);
  });

  it("redacts opaque tokens in SPA hash-route sensitive URL paths", () => {
    const resetToken = "g".repeat(32);
    const out = sanitizeText(
      `Reset at https://app.example.com/#/reset-password/${resetToken}?view=1`,
    );

    expect(out).toContain(
      "https://app.example.com/#/reset-password/[redacted]?view=1",
    );
    expect(out).not.toContain(resetToken);
  });

  it("redacts short route tokens after sensitive URL path segments", () => {
    const out = sanitizeText(
      "Reset at https://app.example.com/#/reset-password/abc123 and url=/share/def456",
    );

    expect(out).toContain("https://app.example.com/#/reset-password/[redacted]");
    expect(out).toContain("url=/share/[redacted]");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("def456");
  });

  it("redacts short route tokens in standalone hash-route strings", () => {
    const out = sanitizeText(
      "Request failed: hash=#/reset-password/abc123 next=#/share/def456",
    );

    expect(out).toContain("hash=#/reset-password/[redacted]");
    expect(out).toContain("next=#/share/[redacted]");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("def456");
  });

  it("redacts codes in nested SPA callback hash routes", () => {
    const out = sanitizeText(
      "Auth failed: hash=#/projects/123/oauth/callback?code=abc123&state=ok",
    );

    expect(out).toContain(
      "hash=#/projects/123/oauth/callback?code=[redacted]&state=ok",
    );
    expect(out).not.toContain("abc123");
  });

  it("redacts codes in colon-prefixed relative sensitive routes", () => {
    const out = sanitizeText(
      "Auth failed: hash:#/projects/123/oauth/callback?code=abc123 url:/oauth/callback?code=def456&state=ok",
    );

    expect(out).toContain(
      "hash:#/projects/123/oauth/callback?code=[redacted]",
    );
    expect(out).toContain("url:/oauth/callback?code=[redacted]&state=ok");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("def456");
  });

  it("redacts codes in nested colon-prefixed relative callback routes", () => {
    const out = sanitizeText(
      "Auth failed: url:/projects/123/oauth/callback?code=abc123&state=ok",
    );

    expect(out).toContain(
      "url:/projects/123/oauth/callback?code=[redacted]&state=ok",
    );
    expect(out).not.toContain("abc123");
  });

  it("redacts codes in bare nested relative callback routes", () => {
    const out = sanitizeText(
      "Auth failed at /projects/123/oauth/callback?code=abc123&state=ok",
    );

    expect(out).toContain(
      "/projects/123/oauth/callback?code=[redacted]&state=ok",
    );
    expect(out).not.toContain("abc123");
  });

  it("redacts codes in relative sensitive route query strings", () => {
    const out = sanitizeText(
      "Request failed: url=/reset-password?code=abc123&state=ok path=/share?code=def456",
    );

    expect(out).toContain("url=/reset-password?code=[redacted]&state=ok");
    expect(out).toContain("path=/share?code=[redacted]");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("def456");
  });

  it("redacts relative sensitive URL paths inside key-value assignments", () => {
    const resetToken = "h".repeat(40);
    const shareToken = "i".repeat(32);
    const out = sanitizeText(
      `Request failed: url=/reset-password/${resetToken}?view=1 path=/share/${shareToken}`,
    );

    expect(out).toContain("url=/reset-password/[redacted]?view=1");
    expect(out).toContain("path=/share/[redacted]");
    expect(out).not.toContain(resetToken);
    expect(out).not.toContain(shareToken);
  });

  it("redacts relative route tokens before query assignment delimiters", () => {
    const out = sanitizeText(
      "Request failed: redirect=/reset-password/abc123&state=ok next=/share/def456&view=1",
    );

    expect(out).toContain("redirect=/reset-password/[redacted]&state=ok");
    expect(out).toContain("next=/share/[redacted]&view=1");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("def456");
  });

  it("redacts login and authorize route tokens", () => {
    const out = sanitizeText(
      "Auth failed at https://app.example.com/login/abc123 and redirect=/authorize/abcd1234",
    );

    expect(out).toContain("https://app.example.com/login/[redacted]");
    expect(out).toContain("redirect=/authorize/[redacted]");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("abcd1234");
  });

  it("preserves benign path segments that contain token words", () => {
    const out = sanitizeText(
      "Read /tmp/tokenizer_config.json and /tmp/access_token_notes.md",
    );

    expect(out).toContain("/tmp/tokenizer_config.json");
    expect(out).toContain("/tmp/access_token_notes.md");
  });

  it("preserves plain macOS private temp paths", () => {
    const path =
      "/private/var/folders/abcdef1234567890abcdef1234567890/T/report.txt";
    const out = sanitizeText(`Read ${path}`);

    expect(out).toContain(path);
  });

  it("preserves extensionless artifact paths under common directories", () => {
    const path = `/tmp/download/${"j".repeat(40)}`;
    const out = sanitizeText(`Read ${path}`);

    expect(out).toContain(path);
  });

  it("preserves opaque-looking path segments in ordinary URLs", () => {
    const docId = "abcdef0123456789abcdef0123456789abcdef01";
    const out = sanitizeText(
      `See https://docs.example.com/path/${docId}?view=compact#section`,
    );

    expect(out).toContain(
      `https://docs.example.com/path/${docId}?view=compact#section`,
    );
  });

  it("redacts sensitive URL params inside longer text", () => {
    const out = sanitizeText(
      "Fetch failed for https://example.com/callback?key=plain-api-key-123&token=secret-token-123&view=1.",
    );

    expect(out).toContain("view=1");
    expect(out).not.toContain("plain-api-key-123");
    expect(out).not.toContain("secret-token-123");
  });

  it("redacts short session and signature URL params", () => {
    const out = sanitizeText(
      "Fetch failed for https://app.example.com/callback?session=abc123&signature=sig123&view=1.",
    );

    expect(out).toContain("view=1");
    expect(out).toContain("session=");
    expect(out).toContain("signature=");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("sig123");
  });

  it("keeps redaction markers unencoded in sanitized URLs", () => {
    const out = sanitizeText(
      "Reset failed at https://app.example.com/reset-password/abc123?session=sid123&view=1",
    );

    expect(out).toContain("/reset-password/[redacted]");
    expect(out).toContain("session=[redacted]");
    expect(out).not.toContain("%5Bredacted%5D");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("sid123");
  });

  it("redacts short OAuth codes in sensitive callback URLs", () => {
    const out = sanitizeText(
      "Auth failed at https://auth.example.com/oauth/callback?code=abc123&state=ok",
    );

    expect(out).toContain("state=ok");
    expect(out).toContain("code=");
    expect(out).not.toContain("abc123");
  });

  it("redacts short OAuth codes in sensitive callback URL fragments", () => {
    const out = sanitizeText(
      "Auth failed at https://auth.example.com/oauth/callback#code=abc123&state=ok",
    );

    expect(out).toContain("state=ok");
    expect(out).toContain("code=");
    expect(out).not.toContain("abc123");
  });

  it("redacts sensitive params in SPA callback URL fragments", () => {
    const out = sanitizeText(
      "Auth failed at https://app.example.com/#/oauth/callback?code=abc123&id_token=short-id-token&state=ok",
    );

    expect(out).toContain("state=ok");
    expect(out).toContain("code=");
    expect(out).toContain("id_token=");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("short-id-token");
  });

  it("redacts short OAuth codes in relative callback URLs", () => {
    const out = sanitizeText(
      "Auth failed: GET /oauth/callback?code=abc123&state=ok",
    );

    expect(out).toContain("state=ok");
    expect(out).toContain("code=[redacted]");
    expect(out).not.toContain("abc123");
  });

  it("redacts short key-value token fragments inside longer text", () => {
    const out = sanitizeText(
      "Request failed: token=1234 access_token=abc123 value=4321 url=/callback?key=short-key&view=1 hash=#access_token=hash-token&state=ok monkey=banana",
    );

    expect(out).toContain("token=[redacted]");
    expect(out).toContain("access_token=[redacted]");
    expect(out).toContain("value=[redacted]");
    expect(out).toContain("view=1");
    expect(out).toContain("state=ok");
    expect(out).toContain("monkey=banana");
    expect(out).not.toContain("1234");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("4321");
    expect(out).not.toContain("short-key");
    expect(out).not.toContain("hash-token");
  });

  it("redacts suffixed sensitive assignment keys inside longer text", () => {
    const out = sanitizeText(
      "Request failed: client_secret=abc123 session_token=def456 id_token=ghi789 note=safe",
    );

    expect(out).toContain("client_secret=[redacted]");
    expect(out).toContain("session_token=[redacted]");
    expect(out).toContain("id_token=[redacted]");
    expect(out).toContain("note=safe");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("def456");
    expect(out).not.toContain("ghi789");
  });

  it("redacts quoted key-value token fragments inside longer text", () => {
    const out = sanitizeText(
      `Request failed: {"access_token":"abc123","client_secret":"def456"} token: "1234" password: 'abc def' value: 'secret value' password='abc,def' authorization: Basic dXNlcjpwYXNz note="safe"`,
    );

    expect(out).toContain(`"access_token":"[redacted]"`);
    expect(out).toContain(`"client_secret":"[redacted]"`);
    expect(out).toContain(`token: "[redacted]"`);
    expect(out).toContain(`password: '[redacted]'`);
    expect(out).toContain(`value: '[redacted]'`);
    expect(out).toContain(`password='[redacted]'`);
    expect(out).toContain(`authorization: [redacted]`);
    expect(out).toContain(`note="safe"`);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("def456");
    expect(out).not.toContain("1234");
    expect(out).not.toContain("abc def");
    expect(out).not.toContain("secret value");
    expect(out).not.toContain("abc,def");
    expect(out).not.toContain("dXNlcjpwYXNz");
  });

  it("redacts mixed text that starts with a credentialed URL", () => {
    const out = sanitizePayload({
      message: "https://user:pass@example.com/foo token=abc123",
    }) as Record<string, unknown>;

    expect(out.message).toContain(
      "https://redacted:redacted@example.com/foo",
    );
    expect(out.message).toContain("token=[redacted]");
    expect(out.message).not.toContain("user:pass");
    expect(out.message).not.toContain("abc123");
    expect(out.message).not.toContain("%20token");
  });

  it("redacts escaped quoted key-value token fragments inside longer text", () => {
    const out = sanitizeText(
      String.raw`Request failed: {"password":"abc\"def"} token='abc\'def' note="safe"`,
    );

    expect(out).toContain(`"password":"[redacted]"`);
    expect(out).toContain(`token='[redacted]'`);
    expect(out).toContain(`note="safe"`);
    expect(out).not.toContain(String.raw`abc\"def`);
    expect(out).not.toContain(String.raw`abc\'def`);
    expect(out).not.toContain("abc");
    expect(out).not.toContain("def");
  });

  it("redacts escaped JSON sensitive fields inside longer text", () => {
    const out = sanitizeText(
      String.raw`Request failed: {\"access_token\":\"abc123\",\"note\":\"safe\"}`,
    );

    expect(out).toContain(String.raw`\"access_token\":\"[redacted]\"`);
    expect(out).toContain(String.raw`\"note\":\"safe\"`);
    expect(out).not.toContain("abc123");
  });

  it("redacts websocket URL tokens inside longer text", () => {
    const out = sanitizeText(
      "Gateway failed at ws://127.0.0.1:51234/api/ws?token=secret-token-123&profile=default",
    );

    expect(out).toContain("profile=default");
    expect(out).not.toContain("secret-token-123");
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
