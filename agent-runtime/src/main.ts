#!/usr/bin/env node
import { OpenAIAgentsEngine } from "./sdk-engine.js";
import { RuntimeService } from "./service.js";
import { NdjsonRpcPeer } from "./transport.js";
import type { JsonObject } from "./types.js";

let peer: NdjsonRpcPeer;
const engine = new OpenAIAgentsEngine(async (input) => {
  return peer.request(
    "tool.invoke",
    {
      name: input.name,
      arguments: input.arguments,
      callId: input.callId,
    } as JsonObject,
    input.sessionId,
    input.runId,
    input.signal,
  );
});
const service = new RuntimeService(engine);
peer = new NdjsonRpcPeer(process.stdin, process.stdout, (request) => service.handle(request));
service.attach(peer);
peer.listen();

process.on("SIGTERM", () => {
  void engine.shutdown().finally(() => process.exit(0));
});

process.on("uncaughtException", (error) => {
  process.stderr.write(`June agent runtime fatal error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
