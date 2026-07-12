import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

const DEFAULT_LOOPBACK_PORT = 8765;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function inspectDevAuth({ desktopEnv = {}, backendEnv = {}, inheritedEnv = {} }) {
  const desktopLocal = isEnabled(inheritedEnv.OS_JUNE_LOCAL_DEV ?? desktopEnv.OS_JUNE_LOCAL_DEV);
  const backendLocal = isEnabled(
    inheritedEnv.JUNE__LOCAL_DEV__ENABLED ?? backendEnv.JUNE__LOCAL_DEV__ENABLED,
  );

  if (desktopLocal !== backendLocal) {
    throw new Error(
      "Cannot start June: OS_JUNE_LOCAL_DEV and JUNE__LOCAL_DEV__ENABLED select different auth modes. Set both to local mode or both to real OS Accounts, then try again.",
    );
  }

  if (desktopLocal) return undefined;

  const port = parseLoopbackPort(
    inheritedEnv.OS_ACCOUNTS_LOOPBACK_PORT ?? desktopEnv.OS_ACCOUNTS_LOOPBACK_PORT,
  );
  const callback = `http://127.0.0.1:${port}/callback`;
  return `OS Accounts development login callback: ${callback}\nAllowlist this exact redirect URI for OS_ACCOUNTS_CLIENT_ID before signing in.`;
}

export function readDevAuthPreflight(rootDir, inheritedEnv = process.env) {
  return inspectDevAuth({
    desktopEnv: readEnv(join(rootDir, ".env"), ".env"),
    backendEnv: readEnv(join(rootDir, "june-api", ".env"), "june-api/.env"),
    inheritedEnv,
  });
}

function readEnv(path, label) {
  if (!existsSync(path)) return {};
  const contents = readFileSync(path, "utf8");
  try {
    return parseEnv(contents);
  } catch {
    throw new Error(`Could not parse ${label}. Fix the env file, then try again.`);
  }
}

function isEnabled(value) {
  return TRUE_VALUES.has(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function parseLoopbackPort(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_LOOPBACK_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_LOOPBACK_PORT;
}
