#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const apiDir = path.join(rootDir, "scribe-api");
const frontendPort = Number.parseInt(process.env.VITE_PORT ?? "1421", 10);
const apiPort = Number.parseInt(process.env.SCRIBE_API_PORT ?? "8080", 10);
const shell = process.platform === "win32";

let apiChild = null;
let frontendChild = null;
let shuttingDown = false;

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

if (!fs.existsSync(path.join(apiDir, "Cargo.toml"))) {
  console.error(`Could not find scribe-api/Cargo.toml under ${rootDir}`);
  process.exit(1);
}

if (await portIsOpen(apiPort)) {
  console.error(
    `Scribe API port ${apiPort} is already in use. Reusing it for Tauri dev.`,
  );
} else {
  apiChild = spawnManaged(
    "scribe-api",
    "cargo",
    ["run", "-p", "scribe", "--", "serve"],
    apiDir,
  );
  apiChild.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`scribe-api exited with ${signal ?? code}`);
    exitFromChild(code, signal);
  });
}

if (await portIsOpen(frontendPort)) {
  console.error(
    `Vite port ${frontendPort} is already in use. Reusing it for Tauri dev.`,
  );
} else {
  frontendChild = spawnManaged("Vite", "pnpm", ["run", "dev"], rootDir);
  frontendChild.on("exit", exitFromChild);
}

if (!frontendChild) {
  setInterval(() => {}, 60 * 60 * 1000);
}
