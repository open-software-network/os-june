#!/usr/bin/env node

import { spawn } from "node:child_process";

const platformBundles = {
  darwin: ["app", "dmg"],
  win32: ["nsis"],
};

const platformConfigs = {
  darwin: "src-tauri/tauri.macos.conf.json",
  win32: "src-tauri/tauri.windows.conf.json",
};

const rawUserArgs = process.argv.slice(2);
const userArgs = rawUserArgs[0] === "--" ? rawUserArgs.slice(1) : rawUserArgs;
const target = optionValue(userArgs, "--target");
const buildPlatform = platformForTarget(target) ?? process.platform;
const bundles = platformBundles[buildPlatform];
const config = platformConfigs[buildPlatform];
const hasBundleOverride = userArgs.some(
  (arg) => arg === "--bundles" || arg.startsWith("--bundles="),
);
const hasConfigOverride = userArgs.some(
  (arg) => arg === "--config" || arg.startsWith("--config="),
);
const args = ["build"];
if (config && !hasConfigOverride) {
  args.push("--config", config);
}
if (bundles && !hasBundleOverride) {
  args.push("--bundles", bundles.join(","));
}
args.push(...userArgs);

const child = spawn("tauri", args, {
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

function optionValue(args, option) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === option) {
      return args[index + 1];
    }
    if (arg.startsWith(`${option}=`)) {
      return arg.slice(option.length + 1);
    }
  }
  return undefined;
}

function platformForTarget(targetTriple) {
  if (!targetTriple) {
    return undefined;
  }
  if (targetTriple.includes("windows")) {
    return "win32";
  }
  if (targetTriple.includes("apple-darwin")) {
    return "darwin";
  }
  return undefined;
}
