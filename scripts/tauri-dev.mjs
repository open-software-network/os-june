#!/usr/bin/env node

import { spawn } from "node:child_process";

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

const child = spawn("tauri", ["dev", ...tauriArgs], {
  env: {
    ...process.env,
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
