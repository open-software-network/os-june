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
const PASSCODE_SALT_BYTES = 16;
const PASSCODE_ITERATIONS = 600_000;

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

export function generatePasscodeSalt(): Uint8Array {
  const salt = new Uint8Array(PASSCODE_SALT_BYTES);
  globalThis.crypto.getRandomValues(salt);
  return salt;
}

/** Derives a wrapping key locally. The passcode and derived key never leave the browser. */
export async function derivePasscodeKey(passcode: string, salt: Uint8Array): Promise<Uint8Array> {
  if (salt.length !== PASSCODE_SALT_BYTES) {
    throw new Error(`Passcode salt must be ${PASSCODE_SALT_BYTES} bytes`);
  }
  const material = await subtle().importKey(
    "raw",
    new TextEncoder().encode(passcode.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await subtle().deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations: PASSCODE_ITERATIONS,
    },
    material,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
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
 * Standard (padded) base64. The share API's `*B64` fields (ciphertext, IVs,
 * envelopes) use this alphabet, because june-api decodes them with the
 * standard base64 decoder. base64url is reserved for the URL fragment, which
 * must stay URL-safe.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
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

/** New anonymous bearer-link fragment. `material` is a raw key or passcode salt. */
export function buildLinkShareFragment(
  inviteId: string,
  material: Uint8Array,
  passwordProtected: boolean,
): string {
  const expected = passwordProtected ? PASSCODE_SALT_BYTES : KEY_BYTES;
  if (material.length !== expected) {
    throw new Error(`Link material must be ${expected} bytes`);
  }
  return `link.${inviteId}.${passwordProtected ? "pass" : "key"}.${toBase64Url(material)}`;
}
