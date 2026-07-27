import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { NdjsonRpcPeer } from "../src/transport.ts";

test("removes settled request abort listeners", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => {
    written += chunk.toString();
  });
  const peer = new NdjsonRpcPeer(input, output, async () => ({}));
  peer.listen();
  const signal = new FakeAbortSignal();

  const result = peer.request("host.log", {}, "session-1", "run-1", signal.value);
  const request = JSON.parse(written.trim()) as { id: string };
  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      protocolVersion: PROTOCOL_VERSION,
      id: request.id,
      result: { accepted: true },
      sessionId: "session-1",
      runId: "run-1",
      sequence: 2,
    })}\n`,
  );

  assert.deepEqual(await result, { accepted: true });
  assert.equal(signal.added, 1);
  assert.equal(signal.removed, 1);
  assert.equal(peer.pending.size, 0);
  input.end();
});

class FakeAbortSignal {
  added = 0;
  removed = 0;
  listener?: EventListenerOrEventListenerObject;

  readonly value = {
    aborted: false,
    addEventListener: (
      _type: string,
      listener: EventListenerOrEventListenerObject,
    ) => {
      this.added += 1;
      this.listener = listener;
    },
    removeEventListener: (
      _type: string,
      listener: EventListenerOrEventListenerObject,
    ) => {
      if (this.listener === listener) this.listener = undefined;
      this.removed += 1;
    },
  } as AbortSignal;
}
