#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureClovyApiEnv } from "./clovy-api-env-compat.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = path.join(rootDir, "clovy-api");
const frontendPort = Number.parseInt(process.env.VITE_PORT ?? "1421", 10);
const apiPort = Number.parseInt(
  process.env.CLOVY_API_PORT ?? process.env.JUNE_API_PORT ?? "8080",
  10,
);
const skipLocalApi =
  (process.env.CLOVY_DEV_SKIP_LOCAL_API ?? process.env.JUNE_DEV_SKIP_LOCAL_API) === "1";
const shell = process.platform === "win32";

let apiChild = null;
let frontendChild = null;
let shuttingDown = false;

async function runRequired(name, command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} exited with ${signal ?? code}`));
    });
  });
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(300, () => done(false));
  });
}

function spawnManaged(name, command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    shell,
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error(`${name} failed to start: ${error.message}`);
    cleanup();
    process.exit(1);
  });

  return child;
}

function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of [frontendChild, apiChild]) {
    if (child && !child.killed) {
      child.kill();
    }
  }
}

function exitFromChild(code, signal) {
  cleanup();
  process.exit(code ?? (signal ? 1 : 0));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => exitFromChild(0, signal));
}

// The Rust host executes agent-runtime/dist/main.js in development. Build it
// before Vite advertises readiness so a clean checkout can send its first turn.
try {
  await runRequired("agent runtime build", "pnpm", ["agent-runtime:build"], rootDir);
} catch (error) {
  console.error(`Agent runtime build failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
if ((process.env.CLOVY_DEV_PREPARE_ONLY ?? process.env.JUNE_DEV_PREPARE_ONLY) === "1") {
  process.exit(0);
}

if (skipLocalApi) {
  console.error("Skipping local Clovy API because CLOVY_DEV_SKIP_LOCAL_API=1.");
} else {
  if (!fs.existsSync(path.join(apiDir, "Cargo.toml"))) {
    console.error(`Could not find clovy-api/Cargo.toml under ${rootDir}`);
    process.exit(1);
  }

  const apiEnv = ensureClovyApiEnv(rootDir);
  if (apiEnv.source === "legacy") {
    console.error("Migrated legacy june-api/.env to clovy-api/.env.");
  }

  if (await portIsOpen(apiPort)) {
    console.error(
      `Clovy API port ${apiPort} became occupied before startup. Restart make dev to select another port.`,
    );
    process.exit(1);
  } else {
    apiChild = spawnManaged(
      "clovy-api",
      "cargo",
      ["run", "-p", "clovy-api-server", "--", "serve"],
      apiDir,
    );
    apiChild.on("exit", (code, signal) => {
      if (shuttingDown) return;
      console.error(`clovy-api exited with ${signal ?? code}`);
      exitFromChild(code, signal);
    });
  }
}

if (await portIsOpen(frontendPort)) {
  console.error(
    `Vite port ${frontendPort} became occupied before startup. Restart make dev to select another port.`,
  );
  process.exit(1);
} else {
  frontendChild = spawnManaged("Vite", "pnpm", ["run", "dev"], rootDir);
  frontendChild.on("exit", exitFromChild);
}

if (!frontendChild) {
  setInterval(() => {}, 60 * 60 * 1000);
}
