import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extensionIdFromManifestKey } from "./extension-release.mjs";

const EXPECTED_EXTENSION_ID = "jfpogffllplkfoooiaibjkojkngbdnik";
const manifestPath = fileURLToPath(new URL("../extension/dist/manifest.json", import.meta.url));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const extensionId = extensionIdFromManifestKey(manifest.key);

if (extensionId !== EXPECTED_EXTENSION_ID) {
  throw new Error(
    `Bundled extension id ${extensionId} does not match ${EXPECTED_EXTENSION_ID}. ` +
      "Keep the source manifest key intact before packaging June.",
  );
}

console.log(`Validated bundled extension id ${extensionId}.`);
