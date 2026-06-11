#!/usr/bin/env node

import { spawn } from "node:child_process";

const REPLAY_ONBOARDING_FLAG = "--replay-onboarding";

let replayOnboarding = false;
const tauriArgs = [];

for (const arg of process.argv.slice(2)) {
  if (arg === REPLAY_ONBOARDING_FLAG) {
    replayOnboarding = true;
  } else {
    tauriArgs.push(arg);
  }
}

const child = spawn("tauri", ["dev", ...tauriArgs], {
  env: {
    ...process.env,
    ...(replayOnboarding ? { VITE_JUNE_REPLAY_ONBOARDING: "1" } : {}),
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
