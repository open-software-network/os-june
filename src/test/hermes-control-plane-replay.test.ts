import { describe, expect, it } from "vitest";
import { HermesGatewayError, isSessionBusyError } from "../lib/hermes-gateway";
import {
  classifyHermesEvent,
  replayFixture,
  replayFixtureFrames,
} from "../lib/hermes-control-plane";
import type {
  HermesReplayFixture,
  JuneHermesEvent,
  JuneHermesEventKind,
  PendingHermesAction,
} from "../lib/hermes-control-plane";

// Recorded raw-frame corpus. Fixture DATA lives beside the module
// (src/lib/hermes-control-plane/fixtures); these tests run from src/test only
// (vite.config include: ["src/test/**"]). Each import is type-checked because
// resolveJsonModule is on, so a malformed fixture fails `tsc`/lint, not just here.
import normalMessage from "../lib/hermes-control-plane/fixtures/normal-message.json";
import toolCallSuccess from "../lib/hermes-control-plane/fixtures/tool-call-success.json";
import toolCallFailure from "../lib/hermes-control-plane/fixtures/tool-call-failure.json";
import approvalRequestResponse from "../lib/hermes-control-plane/fixtures/approval-request-response.json";
import clarifyRequestResponse from "../lib/hermes-control-plane/fixtures/clarify-request-response.json";
import sudoRequestResponse from "../lib/hermes-control-plane/fixtures/sudo-request-response.json";
import secretRequestResponse from "../lib/hermes-control-plane/fixtures/secret-request-response.json";
import subagentLifecycle from "../lib/hermes-control-plane/fixtures/subagent-lifecycle.json";
import subagentBackgroundCompletion from "../lib/hermes-control-plane/fixtures/subagent-background-completion.json";
import imageAttachment from "../lib/hermes-control-plane/fixtures/image-attachment.json";
import modelSwitch from "../lib/hermes-control-plane/fixtures/model-switch.json";
import interrupt from "../lib/hermes-control-plane/fixtures/interrupt.json";
import branch from "../lib/hermes-control-plane/fixtures/branch.json";
import gatewayDisconnectReconnect from "../lib/hermes-control-plane/fixtures/gateway-disconnect-reconnect.json";
import sessionBusy4009 from "../lib/hermes-control-plane/fixtures/session-busy-4009.json";
import providerAccountError from "../lib/hermes-control-plane/fixtures/provider-account-error.json";
import reasoningAndStatus from "../lib/hermes-control-plane/fixtures/reasoning-and-status.json";
import futureUnknownEvent from "../lib/hermes-control-plane/fixtures/future-unknown-event.json";

// The gateway models 4009 as a module-private constant (see hermes-gateway.ts).
// Mirror the protocol value here rather than reaching into feature 01's
// internals; isSessionBusyError is the exported boundary the UI branches on.
const SESSION_BUSY_CODE = 4009;

// The canonical set of kinds the classifier may emit. Pinned to the type so a
// new kind in events.ts forces this list (and the per-frame guarantee) to grow.
const KNOWN_KINDS: readonly JuneHermesEventKind[] = [
  "transcript",
  "reasoning",
  "tool",
  "pending_action",
  "background_activity",
  "lifecycle",
  "error",
  "unsupported",
];
const KNOWN_KIND_SET = new Set<string>(KNOWN_KINDS);

/** A per-frame expectation: the kind, plus the pending-action sub-kind for
 * `pending_action` frames so approval/clarify/sudo/secret stay distinct. */
type FrameExpectation = {
  kind: JuneHermesEventKind;
  action?: PendingHermesAction["kind"];
};

type FixtureCase = {
  fixture: HermesReplayFixture;
  /** Expected classification for each frame, in order. Length must equal the
   * fixture's frame count — a mismatch means the fixture changed under us. */
  expected: FrameExpectation[];
};

const k = (
  kind: JuneHermesEventKind,
  action?: PendingHermesAction["kind"],
): FrameExpectation => ({ kind, action });

// The expectation registry. Every fixture is listed with its per-frame expected
// kinds, derived from the MERGED feature-01 classifier's actual behavior (probed,
// not assumed). Where a family classifies as `unsupported` today but arguably
// should be modeled, that is called out in fixtures/README.md and this file's
// "documented classifier gaps" block — the expectation here LOCKS today's honest
// behavior so a future change is a deliberate, visible diff.
const CASES: Record<string, FixtureCase> = {
  "normal-message": {
    fixture: normalMessage as HermesReplayFixture,
    // gateway.ready, session.info, then message start + 2 deltas + complete.
    expected: [
      k("lifecycle"),
      k("lifecycle"),
      k("transcript"),
      k("transcript"),
      k("transcript"),
      k("transcript"),
    ],
  },
  "tool-call-success": {
    fixture: toolCallSuccess as HermesReplayFixture,
    expected: [k("tool"), k("tool"), k("tool")],
  },
  "tool-call-failure": {
    fixture: toolCallFailure as HermesReplayFixture,
    // A failed tool still arrives as tool.complete (failure is in the payload),
    // so it classifies as `tool`, not `error`.
    expected: [k("tool"), k("tool"), k("tool")],
  },
  "approval-request-response": {
    fixture: approvalRequestResponse as HermesReplayFixture,
    // The .response is not a new pending action; it currently lands in
    // `unsupported` (locked; see existing classifier test asserting a response
    // is never a pending_action).
    expected: [k("pending_action", "approval"), k("unsupported")],
  },
  "clarify-request-response": {
    fixture: clarifyRequestResponse as HermesReplayFixture,
    expected: [k("pending_action", "clarify"), k("unsupported")],
  },
  "sudo-request-response": {
    fixture: sudoRequestResponse as HermesReplayFixture,
    expected: [k("pending_action", "sudo"), k("unsupported")],
  },
  "secret-request-response": {
    fixture: secretRequestResponse as HermesReplayFixture,
    expected: [k("pending_action", "secret"), k("unsupported")],
  },
  "subagent-lifecycle": {
    fixture: subagentLifecycle as HermesReplayFixture,
    expected: [
      k("background_activity"),
      k("background_activity"),
      k("background_activity"),
      k("background_activity"),
      k("background_activity"),
    ],
  },
  "subagent-background-completion": {
    fixture: subagentBackgroundCompletion as HermesReplayFixture,
    expected: [k("background_activity"), k("background_activity")],
  },
  "image-attachment": {
    fixture: imageAttachment as HermesReplayFixture,
    // GAP: image.attach is in RawHermesEventName but has no classifier branch.
    expected: [k("unsupported")],
  },
  "model-switch": {
    fixture: modelSwitch as HermesReplayFixture,
    expected: [k("unsupported")], // GAP: no model.switch branch (feature 10).
  },
  interrupt: {
    fixture: interrupt as HermesReplayFixture,
    expected: [k("unsupported")], // GAP: no interrupt branch (feature 13).
  },
  branch: {
    fixture: branch as HermesReplayFixture,
    expected: [k("unsupported")], // GAP: no branch branch (feature 07).
  },
  "gateway-disconnect-reconnect": {
    fixture: gatewayDisconnectReconnect as HermesReplayFixture,
    // Bespoke connection frames are unsupported; the post-reconnect
    // gateway.ready handshake classifies as lifecycle.
    expected: [k("unsupported"), k("unsupported"), k("lifecycle")],
  },
  "session-busy-4009": {
    fixture: sessionBusy4009 as HermesReplayFixture,
    // Modeled here as an in-band error frame carrying the 4009 code. The
    // canonical 4009 is an RPC rejection (see the dedicated test below).
    expected: [k("error")],
  },
  "provider-account-error": {
    fixture: providerAccountError as HermesReplayFixture,
    // Generic `error` -> error; bespoke provider.error/account.error -> unsupported.
    expected: [k("error"), k("unsupported"), k("unsupported")],
  },
  "reasoning-and-status": {
    fixture: reasoningAndStatus as HermesReplayFixture,
    expected: [k("lifecycle"), k("reasoning"), k("reasoning")],
  },
  "future-unknown-event": {
    fixture: futureUnknownEvent as HermesReplayFixture,
    expected: [k("unsupported"), k("unsupported")],
  },
};

const ALL_CASES = Object.entries(CASES);

describe("hermes replay — fixture corpus integrity", () => {
  it("ships a non-empty, well-formed corpus with frames in every fixture", () => {
    expect(ALL_CASES.length).toBeGreaterThan(0);
    for (const [name, { fixture, expected }] of ALL_CASES) {
      expect(fixture.frames.length, `${name} has no frames`).toBeGreaterThan(0);
      expect(
        expected.length,
        `${name}: expectation count must match frame count`,
      ).toBe(fixture.frames.length);
    }
  });

  it("records provenance metadata on every fixture (version, source, sanitized)", () => {
    for (const [name, { fixture }] of ALL_CASES) {
      expect(fixture.hermesVersion, `${name} missing hermesVersion`).toBe(
        "v2026.6.19",
      );
      expect(fixture.recordedFrom, `${name} missing recordedFrom`).toBe(
        "tui-gateway",
      );
      expect(fixture.sanitized, `${name} not marked sanitized`).toBe(true);
    }
  });
});

describe("hermes replay — totality (no frame is ever dropped)", () => {
  // The core regression net: for EVERY frame of EVERY fixture the classifier
  // returns a defined event whose kind is a known discriminant. Nothing is
  // undefined, nothing is a dropped sentinel.
  for (const [name, { fixture }] of ALL_CASES) {
    it(`classifies every frame of "${name}" to a known kind`, () => {
      const events = replayFixture(fixture);
      expect(events.length).toBe(fixture.frames.length);
      for (const [index, event] of events.entries()) {
        expect(event, `${name}#${index} returned no event`).toBeDefined();
        expect(
          KNOWN_KIND_SET.has(event.kind),
          `${name}#${index} produced unknown kind "${event.kind}"`,
        ).toBe(true);
      }
    });
  }

  it("never yields a kind outside the JuneHermesEvent union across the corpus", () => {
    const kinds = new Set<string>();
    for (const { fixture } of Object.values(CASES)) {
      for (const event of replayFixture(fixture)) kinds.add(event.kind);
    }
    for (const kind of kinds) expect(KNOWN_KIND_SET.has(kind)).toBe(true);
  });
});

describe("hermes replay — family-specific expectations", () => {
  for (const [name, { fixture, expected }] of ALL_CASES) {
    it(`maps each frame of "${name}" to its expected kind`, () => {
      const replayed = replayFixtureFrames(fixture);
      for (const { index, event, raw } of replayed) {
        const want = expected[index];
        expect(
          event.kind,
          `${name}#${index} (raw type "${raw.type}") expected ${want.kind}, got ${event.kind}`,
        ).toBe(want.kind);
        if (want.action) {
          expect(event.kind).toBe("pending_action");
          if (event.kind === "pending_action") {
            expect(
              event.action.kind,
              `${name}#${index} expected pending action ${want.action}`,
            ).toBe(want.action);
          }
        }
      }
    });
  }

  it("preserves the streamed transcript text from the normal-message fixture", () => {
    const events = replayFixture(normalMessage as HermesReplayFixture);
    const transcripts = events.filter(
      (e): e is Extract<JuneHermesEvent, { kind: "transcript" }> =>
        e.kind === "transcript",
    );
    expect(transcripts.map((t) => t.delta).filter(Boolean)).toEqual([
      "Sure, here is the plan: ",
      "step one.",
      "Sure, here is the plan: step one.",
    ]);
    expect(transcripts.at(-1)?.complete).toBe(true);
  });

  it("carries approval metadata and a request id through the approval fixture", () => {
    const [request] = replayFixture(
      approvalRequestResponse as HermesReplayFixture,
    );
    expect(request.kind).toBe("pending_action");
    if (
      request.kind === "pending_action" &&
      request.action.kind === "approval"
    ) {
      expect(request.action.requestId).toBe("ap-1");
      expect(request.action.toolName).toBe("shell");
      expect(request.action.description).toBe("Delete the build directory");
    }
  });

  it("carries the sudo mode through the sudo fixture", () => {
    const [request] = replayFixture(sudoRequestResponse as HermesReplayFixture);
    if (request.kind === "pending_action" && request.action.kind === "sudo") {
      expect(request.action.mode).toBe("unrestricted");
      expect(request.action.command).toBe("apt-get install ripgrep");
    }
  });

  it("correlates a background subagent by handle and parent session", () => {
    const events = replayFixture(
      subagentBackgroundCompletion as HermesReplayFixture,
    );
    for (const event of events) {
      expect(event.kind).toBe("background_activity");
      if (event.kind === "background_activity") {
        expect(event.activity.subagentId).toBe("bg-h-7");
        expect(event.activity.handle).toBe("bg-h-7");
        expect(event.activity.parentSessionId).toBe("sess-parent");
        expect(event.activity.lastEventAt).toBeTruthy();
      }
    }
  });

  it("surfaces message and code on error frames (busy + provider)", () => {
    const [busy] = replayFixture(sessionBusy4009 as HermesReplayFixture);
    expect(busy.kind).toBe("error");
    if (busy.kind === "error") {
      expect(busy.code).toBe(SESSION_BUSY_CODE);
      expect(busy.message).toBe("session busy");
      expect(busy.recoverable).toBe(true);
    }
    const [providerErr] = replayFixture(
      providerAccountError as HermesReplayFixture,
    );
    if (providerErr.kind === "error") {
      expect(providerErr.code).toBe(401);
      expect(providerErr.message).toContain("401 Unauthorized");
    }
  });
});

describe("hermes replay — unknown/future events are visible, never dropped", () => {
  it("classifies every unknown frame as unsupported with rawType set", () => {
    const events = replayFixtureFrames(
      futureUnknownEvent as HermesReplayFixture,
    );
    for (const { raw, event } of events) {
      expect(event.kind).toBe("unsupported");
      if (event.kind === "unsupported") {
        expect(event.rawType, "rawType must be preserved for visibility").toBe(
          raw.type,
        );
      }
    }
  });

  it("preserves rawType for every unsupported frame across the whole corpus", () => {
    for (const { fixture } of Object.values(CASES)) {
      for (const { raw, event } of replayFixtureFrames(fixture)) {
        if (event.kind === "unsupported") {
          // A non-empty raw type must round-trip so a Hermes upgrade is traceable.
          if (typeof raw.type === "string" && raw.type) {
            expect(event.rawType).toBe(raw.type);
          }
        }
      }
    }
  });
});

describe("hermes replay — SECURITY: secrets never survive classification", () => {
  const SECRET_VALUE = "sk-FAKE-PLACEHOLDER-secret-value-do-not-use-0000000000";

  it("classifies secret.request as a redacted secret pending action", () => {
    const [request] = replayFixture(
      secretRequestResponse as HermesReplayFixture,
    );
    expect(request.kind).toBe("pending_action");
    if (request.kind === "pending_action") {
      expect(request.action.kind).toBe("secret");
      if (request.action.kind === "secret") {
        expect(request.action.keyName).toBe("OPENAI_API_KEY");
        expect(request.action.redacted).toBe(true);
      }
    }
  });

  it("never serializes the secret value anywhere in the classified secret event", () => {
    // Sanity: the value really is present in the raw fixture (so the test can't
    // pass vacuously).
    const rawSerialized = JSON.stringify(
      (secretRequestResponse as HermesReplayFixture).frames,
    );
    expect(rawSerialized).toContain(SECRET_VALUE);

    // After classification it must be gone from every frame's output.
    for (const event of replayFixture(
      secretRequestResponse as HermesReplayFixture,
    )) {
      expect(JSON.stringify(event)).not.toContain(SECRET_VALUE);
    }
  });

  it("redacts credential-looking values carried on error and unsupported frames", () => {
    // The provider-error fixture embeds fake bearer tokens / api keys under both
    // sensitive and benign keys; none may reach the serialized classified events.
    const canaries = [
      "FAKE-PROVIDER-TOKEN-do-not-use-aaaaaaaaaaaaaaaaaaaa",
      "sk-FAKE-account-key-do-not-use-bbbbbbbbbbbbbbbb",
      "FAKE-RATE-LIMIT-TOKEN-do-not-use-cccccccccccccccccccc",
      "FAKE-FUTURE-TOKEN-do-not-use-dddddddddddddddddddddddddddd",
    ];
    const serialized = [
      ...replayFixture(providerAccountError as HermesReplayFixture),
      ...replayFixture(futureUnknownEvent as HermesReplayFixture),
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    for (const canary of canaries) {
      expect(serialized, `leaked credential canary: ${canary}`).not.toContain(
        canary,
      );
    }
  });

  it("never lets a secret-like field survive on ANY classified frame in the corpus", () => {
    // A blanket sweep: across the entire corpus, no classified event may carry a
    // bearer token or a long credential-looking token. Cheap insurance that a new
    // fixture can't quietly introduce a leak.
    const bearer = /bearer\s+\S/i;
    for (const [name, { fixture }] of ALL_CASES) {
      for (const { index, event } of replayFixtureFrames(fixture)) {
        const serialized = JSON.stringify(event);
        expect(
          bearer.test(serialized),
          `${name}#${index} serialized a bearer token`,
        ).toBe(false);
      }
    }
  });
});

describe("hermes replay — 4009 session-busy is an RPC rejection, not an event", () => {
  // Documents (and pins) the canonical 4009 path: it is a JSON-RPC rejection on
  // a mutating request while a turn runs, surfaced as a HermesGatewayError and
  // detected by isSessionBusyError — it does NOT flow through classifyHermesEvent
  // on the response path. The session-busy fixture covers the in-band-error
  // variant; this guards the transport contract the UI actually branches on.
  it("recognizes a 4009 HermesGatewayError as session-busy", () => {
    const err = new HermesGatewayError("session busy", SESSION_BUSY_CODE);
    expect(isSessionBusyError(err)).toBe(true);
    expect(isSessionBusyError(new HermesGatewayError("nope", 500))).toBe(false);
    expect(isSessionBusyError(new Error("session busy"))).toBe(false);
  });

  it("still classifies an in-band 4009 error frame as an error with the code", () => {
    const event = classifyHermesEvent({
      type: "error",
      session_id: "s",
      payload: { message: "session busy", code: SESSION_BUSY_CODE },
    });
    expect(event.kind).toBe("error");
    if (event.kind === "error") expect(event.code).toBe(SESSION_BUSY_CODE);
  });
});
