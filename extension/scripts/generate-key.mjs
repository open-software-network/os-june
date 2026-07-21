// Generates a fresh MV3 manifest `key` (base64 SPKI public key) and prints the
// Chrome extension id it pins. Run once when rotating the development key:
//   node extension/scripts/generate-key.mjs
// Paste the key into extension/public/manifest.json and the id into
// src-tauri/src/extension_host.rs (EXTENSION_ID). Chrome derives the id from
// the public key alone, so no private key is kept: load-unpacked only needs
// the `key` field to produce a stable id.
import { createHash, generateKeyPairSync } from "node:crypto";

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = publicKey.export({ type: "spki", format: "der" });
const hash = createHash("sha256").update(der).digest("hex").slice(0, 32);
const id = [...hash]
  .map((c) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(c, 16)))
  .join("");

process.stdout.write(`extension id: ${id}\nmanifest key: ${der.toString("base64")}\n`);
