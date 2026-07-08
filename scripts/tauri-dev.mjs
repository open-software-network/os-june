#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A port is "free" when a connection is refused. Mirrors the probe in
// tauri-before-dev.mjs so both scripts agree on which port to use.
function portIsFree(port) {
  return new Promise((resolveProbe) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (free) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(free);
    };
    socket.once("connect", () => done(false));
    socket.once("error", () => done(true));
    socket.setTimeout(300, () => done(true));
  });
}

// Pick the frontend port before Tauri reads its config, so Vite, the devUrl,
// and before-dev's probe all agree. An explicit VITE_PORT is honored as-is;
// otherwise scan upward from 1421 for a free port so parallel worktrees never
// collide (and never silently reuse each other's Vite).
async function resolveFrontendPort() {
  const explicit = Number.parseInt(process.env.VITE_PORT ?? "", 10);
  if (Number.isInteger(explicit) && explicit > 0) {
    return explicit;
  }
  const base = 1421;
  for (let port = base; port < base + 100; port += 1) {
    if (await portIsFree(port)) {
      return port;
    }
  }
  throw new Error(`No free Vite port found in ${base}..${base + 99}`);
}

const REPLAY_ONBOARDING_FLAG = "--replay-onboarding";
const platformConfigs = {
  darwin: "src-tauri/tauri.macos.conf.json",
  win32: "src-tauri/tauri.windows.conf.json",
};

let replayOnboarding = false;
const tauriArgs = [];
const rawUserArgs = process.argv.slice(2);
const userArgs = rawUserArgs[0] === "--" ? rawUserArgs.slice(1) : rawUserArgs;

for (const arg of userArgs) {
  if (arg === REPLAY_ONBOARDING_FLAG) {
    replayOnboarding = true;
  } else {
    tauriArgs.push(arg);
  }
}

const config = platformConfigs[process.platform];
const hasConfigOverride = tauriArgs.some(
  (arg) => arg === "--config" || arg.startsWith("--config="),
);
if (config && !hasConfigOverride) {
  tauriArgs.unshift("--config", config);
}

const frontendPort = await resolveFrontendPort();
// Merge a devUrl override last so it wins over the file configs, pointing the
// native window at the Vite server that before-dev will start on this port.
tauriArgs.push(
  "--config",
  JSON.stringify({ build: { devUrl: `http://127.0.0.1:${frontendPort}` } }),
);

const child = spawn(tauriCommand(), ["dev", ...tauriArgs], {
  env: {
    ...process.env,
    VITE_PORT: String(frontendPort),
    ...(replayOnboarding ? { VITE_JUNE_REPLAY_ONBOARDING: "1" } : {}),
  },
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

function tauriCommand() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const binary = process.platform === "win32" ? "tauri.cmd" : "tauri";
  const localBinary = resolve(scriptDir, "..", "node_modules", ".bin", binary);
  return existsSync(localBinary) ? localBinary : "tauri";
}
