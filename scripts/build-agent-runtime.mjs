#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEA_RESOURCE = "NODE_SEA_BLOB";
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = join(repoRoot, "agent-runtime");
const bundleRoot = join(repoRoot, ".tauri-agent-runtime");
const workRoot = join(bundleRoot, "work");
const postjectCli = join(runtimeRoot, "node_modules", "postject", "dist", "cli.js");

const args = parseArgs(process.argv.slice(2));

if (args.smoke) {
  await smoke(resolve(args.smoke), args.smokeArch);
  process.exit(0);
}

const target = args.target ?? process.env.JUNE_AGENT_RUNTIME_TARGET ?? defaultTarget();
const output = resolve(
  args.output ??
    join(bundleRoot, target === "windows" ? "june-agent-runtime.exe" : "june-agent-runtime"),
);
if (process.env.JUNE_AGENT_RUNTIME_PREBUILT === "1") {
  await verifyChecksum(output);
  await smoke(output);
  process.stdout.write(`Using prebuilt June agent runtime: ${output}\n`);
  process.exit(0);
}
const hostNode = resolve(args.node ?? process.execPath);
assertNode24(hostNode);
await assertFile(
  join(runtimeRoot, "dist", "sea.cjs"),
  "Build agent-runtime before creating the SEA",
);
await assertFile(postjectCli, "postject is required in agent-runtime devDependencies");

await rm(workRoot, { recursive: true, force: true });
await mkdir(workRoot, { recursive: true });
await mkdir(dirname(output), { recursive: true });

const blob = join(workRoot, "agent-runtime.blob");
const seaConfig = join(workRoot, "sea-config.json");
await writeFile(
  seaConfig,
  `${JSON.stringify(
    {
      main: join(runtimeRoot, "dist", "sea.cjs"),
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  )}\n`,
);
run(hostNode, ["--experimental-sea-config", seaConfig]);

if (target === "universal-apple-darwin") {
  if (process.platform !== "darwin") {
    fail("A universal macOS SEA must be assembled on macOS");
  }
  const x64Node = resolve(args.nodeX64 ?? process.env.JUNE_AGENT_RUNTIME_NODE_X64 ?? "");
  if (!args.nodeX64 && !process.env.JUNE_AGENT_RUNTIME_NODE_X64) {
    fail("Set JUNE_AGENT_RUNTIME_NODE_X64 to an x64 Node 24 executable");
  }
  await assertFile(x64Node, "The x64 Node executable does not exist");
  const arm64Node = resolve(
    args.nodeArm64 ?? process.env.JUNE_AGENT_RUNTIME_NODE_ARM64 ?? hostNode,
  );
  await assertFile(arm64Node, "The arm64 Node executable does not exist");
  assertMachArchitecture(x64Node, "x86_64");
  assertMachArchitecture(arm64Node, "arm64");
  const arm64Output = join(workRoot, "june-agent-runtime-arm64");
  const x64Output = join(workRoot, "june-agent-runtime-x64");
  await inject(arm64Node, arm64Output, blob, true);
  await inject(x64Node, x64Output, blob, true);
  run("lipo", ["-create", arm64Output, x64Output, "-output", output]);
  const architectures = capture("lipo", ["-archs", output]).trim().split(/\s+/).sort();
  if (architectures.join(" ") !== "arm64 x86_64") {
    fail(`Universal runtime has unexpected architectures: ${architectures.join(" ")}`);
  }
  await chmod(output, 0o755);
  signMac(output);
} else if (target === "macos") {
  if (process.platform !== "darwin") fail("A macOS SEA must be assembled on macOS");
  await inject(hostNode, output, blob, true);
  signMac(output);
} else if (target === "windows") {
  if (process.platform !== "win32") fail("A Windows SEA must be assembled on Windows");
  await inject(hostNode, output, blob, false);
} else {
  fail(`Unsupported target: ${target}`);
}

await writeChecksum(output);
await smoke(output);
process.stdout.write(`Built June agent runtime: ${output}\n`);

function parseArgs(raw) {
  const parsed = {};
  for (let index = 0; index < raw.length; index += 1) {
    const key = raw[index];
    if (!key?.startsWith("--")) fail(`Unknown argument: ${key}`);
    const name = key.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = raw[index + 1];
    if (!value || value.startsWith("--")) fail(`${key} requires a value`);
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}

function defaultTarget() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  fail(`SEA packaging is not supported on ${process.platform}`);
}

async function inject(nodeBinary, destination, blobPath, macos) {
  await copyFile(nodeBinary, destination);
  await chmod(destination, 0o755);
  if (macos) run("codesign", ["--remove-signature", destination]);
  const injectArgs = [
    postjectCli,
    destination,
    SEA_RESOURCE,
    blobPath,
    "--sentinel-fuse",
    SEA_FUSE,
  ];
  if (macos) injectArgs.push("--macho-segment-name", "NODE_SEA");
  run(hostNode, injectArgs);
}

function signMac(executable) {
  const identity = process.env.APPLE_SIGNING_IDENTITY?.trim() || "-";
  const signArgs = ["--force", "--sign", identity];
  if (identity !== "-") signArgs.push("--timestamp", "--options", "runtime");
  signArgs.push(executable);
  run("codesign", signArgs);
  run("codesign", ["--verify", "--strict", "--verbose=2", executable]);
}

async function writeChecksum(executable) {
  const digest = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  await writeFile(`${executable}.sha256`, `${digest}\n`);
}

async function verifyChecksum(executable) {
  const expected = (await readFile(`${executable}.sha256`, "utf8")).trim();
  const actual = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  if (!/^[0-9a-f]{64}$/.test(expected) || expected !== actual) {
    fail(`Agent runtime checksum mismatch for ${executable}`);
  }
}

async function smoke(executable, architecture) {
  await assertFile(executable, "Runtime executable does not exist");
  const frame = JSON.stringify({
    jsonrpc: "2.0",
    protocolVersion: 1,
    id: "packaging-smoke",
    method: "runtime.shutdown",
    params: {},
    sessionId: "packaging-smoke-session",
    runId: "packaging-smoke-run",
    sequence: 0,
  });
  const result = await new Promise((resolvePromise, reject) => {
    const command = architecture ? "/usr/bin/arch" : executable;
    const commandArgs = architecture ? [`-${architecture}`, executable] : [];
    const child = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Runtime smoke timed out: ${stderr}`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Runtime smoke exited ${code}: ${stderr}`));
      else resolvePromise(stdout);
    });
    child.stdin.end(`${frame}\n`);
  });
  const response = String(result)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((value) => value.id === "packaging-smoke");
  if (response?.result?.shutdown !== true) {
    fail(`Runtime smoke returned an unexpected response: ${String(result).trim()}`);
  }
}

function assertNode24(nodeBinary) {
  const version = capture(nodeBinary, ["--version"]).trim();
  if (!/^v24\./.test(version)) fail(`Node 24 is required, got ${version} from ${nodeBinary}`);
}

function assertMachArchitecture(nodeBinary, expected) {
  const architectures = capture("lipo", ["-archs", nodeBinary]).trim().split(/\s+/);
  if (!architectures.includes(expected)) {
    fail(`${nodeBinary} does not include the required ${expected} architecture`);
  }
}

async function assertFile(path, message) {
  try {
    await readFile(path);
  } catch {
    fail(`${message}: ${path}`);
  }
}

function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} failed with exit code ${result.status}`);
}

function fail(message) {
  throw new Error(message);
}
