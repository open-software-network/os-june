#!/usr/bin/env node
import { OpenAIAgentsEngine } from "./sdk-engine.js";
import { errorMessage } from "./sanitize.js";
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
  process.stderr.write(`Clovy agent runtime fatal error: ${errorMessage(error)}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  process.stderr.write(`Clovy agent runtime fatal rejection: ${errorMessage(error)}\n`);
  process.exit(1);
});
