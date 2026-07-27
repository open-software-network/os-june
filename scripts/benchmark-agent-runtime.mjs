#!/usr/bin/env node

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import process from "node:process";
import { performance } from "node:perf_hooks";

const executable = process.argv[2];
if (!executable) {
  console.error("Usage: node scripts/benchmark-agent-runtime.mjs <sidecar-path>");
  process.exit(2);
}

const startedAt = performance.now();
const child = spawn(executable, [], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
let firstFrameAt;

const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    firstFrameAt ??= performance.now();
    const frame = JSON.parse(line);
    const waiter = pending.get(frame.id);
    if (waiter) {
      pending.delete(frame.id);
      waiter(frame);
    }
  }
});

let nextId = 0;
function request(method, params = {}) {
  const id = `benchmark-${++nextId}`;
  const response = new Promise((resolve) => pending.set(id, resolve));
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      protocolVersion: 1,
      id,
      sessionId: "benchmark",
      runId: "benchmark",
      sequence: nextId,
      method,
      params,
    })}\n`,
  );
  return response;
}

const initializeStartedAt = performance.now();
const initialized = await request("runtime.initialize", {
  clientName: "June runtime benchmark",
  clientVersion: "0.0.0",
});
const initializedAt = performance.now();
if (initialized.error) throw new Error(JSON.stringify(initialized.error));

const shutdownStartedAt = performance.now();
const shutdown = await request("runtime.shutdown");
const shutdownAt = performance.now();
if (shutdown.error) throw new Error(JSON.stringify(shutdown.error));
child.stdin.end();
await new Promise((resolve, reject) => {
  child.once("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`Sidecar exited ${code}`)),
  );
});

const payload = await stat(executable);
console.log(
  JSON.stringify(
    {
      executable,
      payloadBytes: payload.size,
      initializedRssBytes: initialized.result?.rssBytes ?? null,
      processSpawnToInitializeMs: round(initializedAt - startedAt),
      initializeRoundTripMs: round(initializedAt - initializeStartedAt),
      firstFrameMs: firstFrameAt === undefined ? null : round(firstFrameAt - startedAt),
      shutdownRoundTripMs: round(shutdownAt - shutdownStartedAt),
      totalLifetimeMs: round(performance.now() - startedAt),
    },
    null,
    2,
  ),
);

function round(value) {
  return Math.round(value * 100) / 100;
}
