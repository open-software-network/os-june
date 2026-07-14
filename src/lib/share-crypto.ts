/**
 * Client-side crypto for private sharing (JUN-308). WebCrypto only; used by
 * both the June app webview and the browser viewer. See
 * docs/private-sharing-design.md.
 *
 * - Content key (CK): 256-bit random per share; encrypts the share payload
 *   with AES-256-GCM under a random 96-bit IV.
 * - Invite key (IK): 256-bit random per invite; the per-recipient envelope is
 *   AES-256-GCM(CK, key = IK). The server only ever sees ciphertext,
 *   envelopes, and IVs; IK travels in the link fragment and CK never leaves
 *   the client except wrapped in envelopes.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;

function subtle(): SubtleCrypto {
  const subtleCrypto = globalThis.crypto?.subtle;
  if (!subtleCrypto) {
    throw new Error("WebCrypto is unavailable in this environment");
  }
  return subtleCrypto;
}

/** 32 random bytes: a fresh AES-256 content or invite key. */
export function generateKey(): Promise<Uint8Array> {
  const key = new Uint8Array(KEY_BYTES);
  globalThis.crypto.getRandomValues(key);
  return Promise.resolve(key);
}

async function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (raw.length !== KEY_BYTES) {
    throw new Error(`AES-256 key must be ${KEY_BYTES} bytes`);
  }
  return subtle().importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, usages);
}

async function aesGcmEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const iv = new Uint8Array(IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  const cryptoKey = await importAesKey(key, ["encrypt"]);
  const encrypted = await subtle().encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    cryptoKey,
    plaintext as BufferSource,
  );
  return { ciphertext: new Uint8Array(encrypted), iv };
}

async function aesGcmDecrypt(
  key: Uint8Array,
  ciphertext: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await importAesKey(key, ["decrypt"]);
  const decrypted = await subtle().decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    cryptoKey,
    ciphertext as BufferSource,
  );
  return new Uint8Array(decrypted);
}

/** AES-256-GCM of the canonical JSON payload under the content key. */
export async function encryptPayload(
  key: Uint8Array,
  plaintext: string,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  return aesGcmEncrypt(key, new TextEncoder().encode(plaintext));
}

export async function decryptPayload(
  key: Uint8Array,
  ciphertext: Uint8Array,
  iv: Uint8Array,
): Promise<string> {
  const plaintext = await aesGcmDecrypt(key, ciphertext, iv);
  return new TextDecoder().decode(plaintext);
}

/** Wraps the raw content key under a recipient's invite key. */
export async function wrapKey(
  inviteKey: Uint8Array,
  contentKey: Uint8Array,
): Promise<{ envelope: Uint8Array; iv: Uint8Array }> {
  const { ciphertext, iv } = await aesGcmEncrypt(inviteKey, contentKey);
  return { envelope: ciphertext, iv };
}

export async function unwrapKey(
  inviteKey: Uint8Array,
  envelope: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const contentKey = await aesGcmDecrypt(inviteKey, envelope, iv);
  if (contentKey.length !== KEY_BYTES) {
    throw new Error("Unwrapped content key has an unexpected length");
  }
  return contentKey;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * The link fragment that carries a recipient's key material:
 * `{invite_id}.{base64url(invite key)}`. The fragment never leaves the
 * recipient's browser.
 */
export function buildShareFragment(inviteId: string, inviteKey: Uint8Array): string {
  return `${inviteId}.${toBase64Url(inviteKey)}`;
}

/** Inverse of buildShareFragment; returns null for a malformed fragment. */
export function parseShareFragment(
  fragment: string,
): { inviteId: string; inviteKey: Uint8Array } | null {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const separator = raw.lastIndexOf(".");
  if (separator <= 0 || separator === raw.length - 1) return null;
  const inviteId = raw.slice(0, separator);
  try {
    const inviteKey = fromBase64Url(raw.slice(separator + 1));
    if (inviteKey.length !== KEY_BYTES) return null;
    return { inviteId, inviteKey };
  } catch {
    return null;
  }
}
