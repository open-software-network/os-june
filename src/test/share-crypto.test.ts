import { describe, expect, it } from "vitest";
import {
  buildShareFragment,
  decryptPayload,
  encryptPayload,
  fromBase64,
  fromBase64Url,
  generateKey,
  parseShareFragment,
  toBase64,
  toBase64Url,
  unwrapKey,
  wrapKey,
} from "../lib/share-crypto";
import { buildNotePayload, buildSessionPayload } from "../lib/share-payload";

describe("share-crypto", () => {
  it("generates distinct 32-byte keys", async () => {
    const first = await generateKey();
    const second = await generateKey();
    expect(first).toHaveLength(32);
    expect(second).toHaveLength(32);
    expect(toBase64Url(first)).not.toBe(toBase64Url(second));
  });

  it("round-trips a payload through encrypt and decrypt", async () => {
    const key = await generateKey();
    const payload = buildNotePayload({
      title: "Weekly sync",
      markdown: "# Notes\n\nUnicode: café ☕ and emoji 🎉",
      sharedAt: "2026-07-14T00:00:00.000Z",
    });
    const { ciphertext, iv } = await encryptPayload(key, payload);
    expect(iv).toHaveLength(12);
    expect(ciphertext.length).toBeGreaterThan(0);
    await expect(decryptPayload(key, ciphertext, iv)).resolves.toBe(payload);
  });

  it("uses a fresh IV per encryption", async () => {
    const key = await generateKey();
    const first = await encryptPayload(key, "same plaintext");
    const second = await encryptPayload(key, "same plaintext");
    expect(toBase64Url(first.iv)).not.toBe(toBase64Url(second.iv));
    expect(toBase64Url(first.ciphertext)).not.toBe(toBase64Url(second.ciphertext));
  });

  it("round-trips a content key through wrap and unwrap", async () => {
    const inviteKey = await generateKey();
    const contentKey = await generateKey();
    const { envelope, iv } = await wrapKey(inviteKey, contentKey);
    const unwrapped = await unwrapKey(inviteKey, envelope, iv);
    expect(toBase64Url(unwrapped)).toBe(toBase64Url(contentKey));
  });

  it("fails to decrypt tampered ciphertext", async () => {
    const key = await generateKey();
    const { ciphertext, iv } = await encryptPayload(key, "sensitive content");
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;
    await expect(decryptPayload(key, tampered, iv)).rejects.toThrow();
  });

  it("fails to unwrap with the wrong invite key", async () => {
    const inviteKey = await generateKey();
    const otherInviteKey = await generateKey();
    const contentKey = await generateKey();
    const { envelope, iv } = await wrapKey(inviteKey, contentKey);
    await expect(unwrapKey(otherInviteKey, envelope, iv)).rejects.toThrow();
  });

  it("round-trips base64url including bytes that need - and _", () => {
    const bytes = new Uint8Array(256);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
    const encoded = toBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(fromBase64Url(encoded))).toEqual(Array.from(bytes));
  });

  it("encodes API fields as standard base64 (padded, + and /)", () => {
    // The share API's *B64 fields are decoded server-side with the standard
    // alphabet. This byte range forces both + and / so a base64url regression
    // (which the server would reject) fails the test loudly.
    const bytes = new Uint8Array(256);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
    const encoded = toBase64(bytes);
    expect(encoded).toMatch(/[+/]/);
    expect(encoded).not.toMatch(/[-_]/);
    expect(Array.from(fromBase64(encoded))).toEqual(Array.from(bytes));
  });

  it("builds and parses a share fragment", async () => {
    const inviteKey = await generateKey();
    const fragment = buildShareFragment("shi_abc123", inviteKey);
    expect(fragment.startsWith("shi_abc123.")).toBe(true);
    const parsed = parseShareFragment(`#${fragment}`);
    expect(parsed).not.toBeNull();
    expect(parsed?.inviteId).toBe("shi_abc123");
    expect(toBase64Url(parsed?.inviteKey ?? new Uint8Array())).toBe(toBase64Url(inviteKey));
  });

  it("rejects malformed fragments", () => {
    expect(parseShareFragment("")).toBeNull();
    expect(parseShareFragment("no-separator")).toBeNull();
    expect(parseShareFragment("shi_x.")).toBeNull();
    expect(parseShareFragment("shi_x.tooshort")).toBeNull();
  });
});

describe("share-payload", () => {
  it("builds a canonical note payload", () => {
    const payload = buildNotePayload({
      title: "Title",
      markdown: "body",
      sharedAt: "2026-07-14T12:00:00.000Z",
    });
    expect(JSON.parse(payload)).toEqual({
      v: 1,
      kind: "note",
      title: "Title",
      markdown: "body",
      shared_at: "2026-07-14T12:00:00.000Z",
    });
  });

  it("builds a canonical session payload with only role and content", () => {
    const payload = buildSessionPayload({
      title: "Session",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      sharedAt: "2026-07-14T12:00:00.000Z",
    });
    expect(JSON.parse(payload)).toEqual({
      v: 1,
      kind: "session",
      title: "Session",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      shared_at: "2026-07-14T12:00:00.000Z",
    });
  });
});
