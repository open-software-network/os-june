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
const macRuntimeEntitlements = join(repoRoot, "src-tauri", "AgentRuntimeEntitlements.plist");

const args = parseArgs(process.argv.slice(2));

if (args.smoke) {
  await smoke(resolve(args.smoke), args.smokeArch);
  process.exit(0);
}
if (args.finalize) {
  await finalize(resolve(args.finalize));
  process.exit(0);
}
if (args.verify) {
  const executable = resolve(args.verify);
  await verifyChecksum(executable);
  await smoke(executable);
  process.exit(0);
}

const target =
  args.target ??
  compatibleEnv("CLOVY_AGENT_RUNTIME_TARGET", "JUNE_AGENT_RUNTIME_TARGET") ??
  defaultTarget();
const output = resolve(
  args.output ??
    join(bundleRoot, target === "windows" ? "clovy-agent-runtime.exe" : "clovy-agent-runtime"),
);
if (compatibleEnv("CLOVY_AGENT_RUNTIME_PREBUILT", "JUNE_AGENT_RUNTIME_PREBUILT") === "1") {
  await verifyChecksum(output);
  await smoke(output);
  process.stdout.write(`Using prebuilt Clovy agent runtime: ${output}\n`);
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
  const configuredX64Node = compatibleEnv(
    "CLOVY_AGENT_RUNTIME_NODE_X64",
    "JUNE_AGENT_RUNTIME_NODE_X64",
  );
  const x64Node = resolve(args.nodeX64 ?? configuredX64Node ?? "");
  if (!args.nodeX64 && !configuredX64Node) {
    fail("Set CLOVY_AGENT_RUNTIME_NODE_X64 to an x64 Node 24 executable");
  }
  await assertFile(x64Node, "The x64 Node executable does not exist");
  const arm64Node = resolve(
    args.nodeArm64 ??
      compatibleEnv("CLOVY_AGENT_RUNTIME_NODE_ARM64", "JUNE_AGENT_RUNTIME_NODE_ARM64") ??
      hostNode,
  );
  await assertFile(arm64Node, "The arm64 Node executable does not exist");
  assertMachArchitecture(x64Node, "x86_64");
  assertMachArchitecture(arm64Node, "arm64");
  const arm64Output = join(workRoot, "clovy-agent-runtime-arm64");
  const x64Output = join(workRoot, "clovy-agent-runtime-x64");
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

await finalize(output);
process.stdout.write(`Built Clovy agent runtime: ${output}\n`);

function parseArgs(raw) {
  const supported = new Set([
    "smoke",
    "smokeArch",
    "finalize",
    "verify",
    "target",
    "output",
    "node",
    "nodeX64",
    "nodeArm64",
  ]);
  const parsed = {};
  for (let index = 0; index < raw.length; index += 1) {
    const key = raw[index];
    if (!key?.startsWith("--")) fail(`Unknown argument: ${key}`);
    const name = key.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!supported.has(name)) fail(`Unknown option: ${key}`);
    if (name in parsed) fail(`Option may only be specified once: ${key}`);
    const value = raw[index + 1];
    if (!value || value.startsWith("--")) fail(`${key} requires a value`);
    parsed[name] = value;
    index += 1;
  }
  const operationModes = ["smoke", "finalize", "verify"].filter((name) => parsed[name]);
  if (operationModes.length > 1) fail("--smoke, --finalize, and --verify are mutually exclusive");
  if (parsed.smokeArch && !parsed.smoke) fail("--smoke-arch requires --smoke");
  if (operationModes.length > 0) {
    const allowed = new Set([...operationModes, ...(parsed.smoke ? ["smokeArch"] : [])]);
    const invalid = Object.keys(parsed).filter((name) => !allowed.has(name));
    if (invalid.length > 0) fail(`Mode option cannot be combined with --${invalid[0]}`);
  }
  return parsed;
}

function defaultTarget() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  fail(`SEA packaging is not supported on ${process.platform}`);
}

function compatibleEnv(canonical, legacy) {
  return process.env[canonical] ?? process.env[legacy];
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
  const signArgs = [
    "--force",
    "--sign",
    identity,
    "--options",
    "runtime",
    "--entitlements",
    macRuntimeEntitlements,
  ];
  if (identity !== "-") signArgs.push("--timestamp");
  signArgs.push(executable);
  run("codesign", signArgs);
  run("codesign", ["--verify", "--strict", "--verbose=2", executable]);
  verifyMacRuntimeEntitlements(executable);
}

function verifyMacRuntimeEntitlements(executable) {
  const result = spawnSync("codesign", ["-d", "--entitlements", "-", executable], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0) {
    fail(`Could not read agent runtime entitlements: ${output.trim()}`);
  }
  for (const entitlement of [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
  ]) {
    if (!output.includes(entitlement)) {
      fail(`Signed agent runtime is missing ${entitlement}`);
    }
  }
}

async function writeChecksum(executable) {
  const digest = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  await writeFile(`${executable}.sha256`, `${digest}\n`);
}

async function finalize(executable) {
  await assertFile(executable, "Runtime executable does not exist");
  await writeChecksum(executable);
  await verifyChecksum(executable);
  await smoke(executable);
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
    // The first launch of a freshly signed universal binary can spend more
    // than ten seconds in macOS signature and architecture validation on a
    // cold release runner. Keep the smoke bounded, but leave enough headroom
    // for that one-time platform work before treating the runtime as hung.
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Runtime smoke timed out: ${stderr}`));
    }, 30_000);
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
