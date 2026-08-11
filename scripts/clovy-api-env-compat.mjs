import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRootDir = path.resolve(path.dirname(scriptPath), "..");

export function ensureClovyApiEnv(rootDir) {
  const canonicalEnvPath = path.join(rootDir, "clovy-api", ".env");
  if (fs.existsSync(canonicalEnvPath)) {
    return { source: "canonical", path: canonicalEnvPath };
  }

  const legacyEnvPath = path.join(rootDir, "june-api", ".env");
  if (!fs.existsSync(legacyEnvPath)) {
    return { source: "none", path: canonicalEnvPath };
  }

  try {
    fs.copyFileSync(legacyEnvPath, canonicalEnvPath, fs.constants.COPYFILE_EXCL);
    return { source: "legacy", path: canonicalEnvPath };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return { source: "canonical", path: canonicalEnvPath };
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const result = ensureClovyApiEnv(defaultRootDir);
  if (result.source === "legacy") {
    console.error("Migrated legacy june-api/.env to clovy-api/.env.");
  }
}
