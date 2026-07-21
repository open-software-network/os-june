import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyHermesEvent } from "../lib/hermes-control-plane";
import { PENDING_ACTIONS_CAP, createPendingActionStore } from "../lib/hermes-pending-actions";

// Build a classified `pending_action` event from a raw `*.request` frame — the
// store's only ingest input. Throws if the frame didn't classify as pending so
// a test can't silently feed the wrong kind.
function pendingClassified(
  type: string,
  sessionId: string | undefined,
  payload?: Record<string, unknown>,
) {
  const event = classifyHermesEvent({ type, session_id: sessionId, payload });
  if (event.kind !== "pending_action") {
    throw new Error(`expected pending_action, got ${event.kind} for ${type}`);
  }
  return event;
}

describe("createPendingActionStore", () => {
  let now: number;

  function setNow(value: number): void {
    now = value;
    vi.setSystemTime(now);
  }
  function advance(ms: number): void {
    setNow(now + ms);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    setNow(Date.UTC(2026, 5, 24, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("two pending actions in two sessions produce two open records", () => {
    const store = createPendingActionStore();
    store.record(
      pendingClassified("clarify.request", "s1", {
        request_id: "r1",
        question: "Which file?",
      }),
      "sandboxed",
    );
    store.record(
      pendingClassified("approval.request", "s2", {
        request_id: "r2",
        tool_name: "write_file",
      }),
      "unrestricted",
    );

    const open = store.openRecords();
    expect(open).toHaveLength(2);
    expect(store.openCount()).toBe(2);
    expect(open.map((r) => r.sessionId).sort()).toEqual(["s1", "s2"]);
    expect(open.map((r) => r.action.kind).sort()).toEqual(["approval", "clarify"]);
  });

  it("keys by mode + sessionId + requestId and distinguishes mode", () => {
    const store = createPendingActionStore();
    store.record(pendingClassified("clarify.request", "s1", { request_id: "r1" }), "sandboxed");
    const [record] = store.openRecords();
    expect(record.key).toBe("sandboxed:s1:r1");
    expect(record.mode).toBe("sandboxed");
  });

  it("responding to one action removes only that row", () => {
    const store = createPendingActionStore();
    store.record(pendingClassified("clarify.request", "s1", { request_id: "r1" }), "sandboxed");
    store.record(pendingClassified("approval.request", "s2", { request_id: "r2" }), "unrestricted");

    store.resolveRequest("s1", "r1");

    const open = store.openRecords();
    expect(open).toHaveLength(1);
    expect(open[0].sessionId).toBe("s2");
    // The resolved record still exists in the full set, marked resolved — not
    // silently dropped, so an activity drawer can show recent history.
    const resolved = store.getRecords().find((r) => r.sessionId === "s1");
    expect(resolved?.status).toBe("resolved");
  });

  it("re-recording an identical request does not duplicate the row", () => {
    const store = createPendingActionStore();
    store.record(pendingClassified("clarify.request", "s1", { request_id: "r1" }), "sandboxed");
    advance(1000);
    store.record(pendingClassified("clarify.request", "s1", { request_id: "r1" }), "sandboxed");

    const open = store.openRecords();
    expect(open).toHaveLength(1);
    // The repeat refreshes lastSeenAt but keeps the original firstSeenAt.
    expect(open[0].firstSeenAt).toBe(Date.UTC(2026, 5, 24, 12, 0, 0));
    expect(open[0].lastSeenAt).toBe(Date.UTC(2026, 5, 24, 12, 0, 1));
  });

  it("a resolved action is not re-opened by a duplicate late event", () => {
    const store = createPendingActionStore();
    store.record(pendingClassified("clarify.request", "s1", { request_id: "r1" }), "sandboxed");
    store.resolveRequest("s1", "r1");
    // A straggler duplicate of the same request must not resurrect the row.
    store.record(pendingClassified("clarify.request", "s1", { request_id: "r1" }), "sandboxed");
    expect(store.openRecords()).toHaveLength(0);
  });

  it("resolveSession() resolves every open action for a completed/interrupted session", () => {
    const store = createPendingActionStore();
    store.record(pendingClassified("clarify.request", "s1", { request_id: "r1" }), "sandboxed");
    store.record(pendingClassified("secret.request", "s1", { request_id: "r2" }), "sandboxed");
    store.record(pendingClassified("approval.request", "s2", { request_id: "r3" }), "unrestricted");

    store.resolveSession("s1");

    const open = store.openRecords();
    expect(open).toHaveLength(1);
    expect(open[0].sessionId).toBe("s2");
  });

  it("gateway reconnect does NOT clear pending actions; unreconciled become stale, still visible", () => {
    const store = createPendingActionStore();
    store.record(pendingClassified("approval.request", "s1", { request_id: "r1" }), "unrestricted");

    // Simulate a disconnect/reconnect: the spec forbids dropping pending
    // actions on disconnect, so nothing happens on disconnect itself.
    store.markDisconnected();
    expect(store.openCount()).toBe(1);

    // After reconnect, anything not reconfirmed by a fresh event is marked
    // `stale` — visible (still blocking-aware) but visually distinct, never
    // silently removed.
    store.reconcileAfterReconnect();
    const record = store.getRecords().find((r) => r.sessionId === "s1");
    expect(record).toBeDefined();
    expect(record?.status).toBe("stale");
    // A stale action still surfaces in the tray (the user can still act on or
    // dismiss it) — it is NOT hidden.
    expect(store.openRecords().map((r) => r.sessionId)).toContain("s1");
  });

  it("a fresh event after reconnect re-confirms a record back to open", () => {
    const store = createPendingActionStore();
    store.record(pendingClassified("approval.request", "s1", { request_id: "r1" }), "unrestricted");
    store.reconcileAfterReconnect();
    expect(store.getRecords().find((r) => r.sessionId === "s1")?.status).toBe("stale");

    // The same request re-announced by Hermes after reconnect proves it is
    // still pending → back to a normal open row.
    store.record(pendingClassified("approval.request", "s1", { request_id: "r1" }), "unrestricted");
    expect(store.getRecords().find((r) => r.sessionId === "s1")?.status).toBe("open");
  });

  it("resolving a stale action removes it from the open set", () => {
    const store = createPendingActionStore();
    store.record(pendingClassified("clarify.request", "s1", { request_id: "r1" }), "sandboxed");
    store.reconcileAfterReconnect();
    store.resolveRequest("s1", "r1");
    expect(store.openRecords()).toHaveLength(0);
  });

  it("retires an expired approval without letting a replay reopen it", () => {
    const store = createPendingActionStore();
    const request = pendingClassified("approval.request", "s1", { request_id: "r-expired" });
    store.record(request, "sandboxed");

    store.expireRequest("s1", "r-expired", "timeout");
    expect(store.openCount()).toBe(0);
    expect(store.getRecords()[0]).toMatchObject({
      requestId: "r-expired",
      status: "expired",
      retiredReason: "timeout",
    });

    store.record(request, "sandboxed");
    expect(store.openCount()).toBe(0);
    expect(store.getRecords()[0]?.status).toBe("expired");

    store.resolveRequest("s1", "r-expired");
    store.resolveSession("s1");
    expect(store.getRecords()[0]?.status).toBe("expired");
  });

  it("allows the same payload-fingerprint approval in a later Agent run", () => {
    const store = createPendingActionStore();
    const legacyRequest = pendingClassified("approval.request", "s1", {
      description: "Connect Todoist?",
      allow_permanent: false,
    });
    if (legacyRequest.action.kind !== "approval") throw new Error("Expected an approval");

    store.record(legacyRequest, "sandboxed", { approvalRunEpoch: 1 });
    store.expireRequest("s1", legacyRequest.action.requestId, "disconnect");
    store.record(legacyRequest, "sandboxed", { approvalRunEpoch: 2 });

    expect(store.openRecords()).toHaveLength(1);
    expect(store.openRecords()[0]).toMatchObject({
      requestId: legacyRequest.action.requestId,
      approvalRunEpoch: 2,
      status: "open",
    });

    store.expireRequest("s1", legacyRequest.action.requestId, "disconnect");
    store.record(legacyRequest, "sandboxed", { approvalRunEpoch: 2 });
    expect(store.openRecords()).toHaveLength(0);
  });

  it("retires only the targeted payload-fingerprint approval instance", () => {
    const store = createPendingActionStore();
    const legacyRequest = pendingClassified("approval.request", "s1", {
      description: "Connect Todoist?",
      allow_permanent: false,
    });
    if (legacyRequest.action.kind !== "approval") throw new Error("Expected an approval");

    store.record(legacyRequest, "sandboxed", { approvalRunEpoch: 1 });
    const firstInstance = store.openRecords()[0]?.instanceId;
    if (!firstInstance) throw new Error("Expected the first approval instance");
    store.expireRequest("s1", legacyRequest.action.requestId, "disconnect", {
      instanceId: firstInstance,
    });

    store.record(legacyRequest, "sandboxed", { approvalRunEpoch: 2 });
    const laterInstance = store.openRecords()[0]?.instanceId;
    if (!laterInstance) throw new Error("Expected the later approval instance");
    expect(laterInstance).not.toBe(firstInstance);

    store.resolveRequest("s1", legacyRequest.action.requestId, { instanceId: firstInstance });
    store.expireRequest("s1", legacyRequest.action.requestId, "disconnect", {
      instanceId: firstInstance,
    });
    expect(store.openRecords()).toEqual([
      expect.objectContaining({ instanceId: laterInstance, status: "open" }),
    ]);

    store.resolveRequest("s1", legacyRequest.action.requestId, { instanceId: laterInstance });
    expect(store.openRecords()).toHaveLength(0);
  });

  it("keeps an explicit approval id globally sticky even when it uses the legacy prefix", () => {
    const store = createPendingActionStore();
    const explicitRequest = pendingClassified("approval.request", "s1", {
      request_id: "legacy:approval.request:upstream-owned",
      description: "Connect Todoist?",
    });

    store.record(explicitRequest, "sandboxed", { approvalRunEpoch: 1 });
    store.expireRequest("s1", "legacy:approval.request:upstream-owned", "disconnect");
    store.record(explicitRequest, "sandboxed", { approvalRunEpoch: 2 });

    expect(store.openRecords()).toHaveLength(0);
  });

  it("secret actions never carry a value, only the request", () => {
    const store = createPendingActionStore();
    store.record(
      pendingClassified("secret.request", "s1", {
        request_id: "r1",
        key_name: "OPENAI_API_KEY",
        // Even if the gateway erroneously included a value, the classifier
        // strips it; the store records only what the classifier hands it.
        value: "sk-thisshouldnevershowup0123456789",
      }),
      "sandboxed",
    );
    const [record] = store.openRecords();
    expect(record.action.kind).toBe("secret");
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("sk-thisshouldnevershowup0123456789");
    if (record.action.kind === "secret") {
      expect(record.action.redacted).toBe(true);
      expect(record.action.keyName).toBe("OPENAI_API_KEY");
    }
  });

  it("notifies subscribers on record and resolution, and bumps version", () => {
    const store = createPendingActionStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const v0 = store.getVersion();

    store.record(pendingClassified("clarify.request", "s1", { request_id: "r1" }), "sandboxed");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getVersion()).toBeGreaterThan(v0);

    store.resolveRequest("s1", "r1");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.record(pendingClassified("clarify.request", "s2", { request_id: "r2" }), "sandboxed");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("resolving an unknown request is a no-op (no throw, no version bump)", () => {
    const store = createPendingActionStore();
    const v0 = store.getVersion();
    expect(() => store.resolveRequest("ghost", "nope")).not.toThrow();
    expect(store.getVersion()).toBe(v0);
  });

  it("ignores a pending_action event with an empty session id", () => {
    const store = createPendingActionStore();
    // The classifier emits sessionId "" when a frame lacks one; such an action
    // can't be attributed to a session a user could open, so it is dropped.
    store.record(
      pendingClassified("clarify.request", undefined, { request_id: "r1" }),
      "sandboxed",
    );
    expect(store.openRecords()).toHaveLength(0);
  });

  it("bounds total records, evicting the oldest resolved first", () => {
    const store = createPendingActionStore();
    // Fill past the cap with resolved records, then add open ones; the open
    // ones must survive because eviction prefers already-resolved history.
    for (let i = 0; i < PENDING_ACTIONS_CAP; i += 1) {
      store.record(
        pendingClassified("clarify.request", `s${i}`, { request_id: `r${i}` }),
        "sandboxed",
      );
      store.resolveRequest(`s${i}`, `r${i}`);
    }
    store.record(
      pendingClassified("approval.request", "live", { request_id: "rlive" }),
      "unrestricted",
    );
    expect(store.getRecords().length).toBeLessThanOrEqual(PENDING_ACTIONS_CAP);
    expect(store.openRecords().map((r) => r.sessionId)).toContain("live");
  });

  it("evicts expired history before an older unanswered action", () => {
    const store = createPendingActionStore();
    store.record(
      pendingClassified("approval.request", "old-live", { request_id: "old-live" }),
      "unrestricted",
    );
    for (let i = 0; i < PENDING_ACTIONS_CAP - 1; i += 1) {
      const sessionId = `expired-${i}`;
      const requestId = `expired-request-${i}`;
      store.record(
        pendingClassified("approval.request", sessionId, { request_id: requestId }),
        "unrestricted",
      );
      store.expireRequest(sessionId, requestId, "timeout");
    }

    store.record(
      pendingClassified("approval.request", "new-live", { request_id: "new-live" }),
      "unrestricted",
    );

    expect(store.getRecords()).toHaveLength(PENDING_ACTIONS_CAP);
    expect(store.openRecords().map((record) => record.sessionId)).toEqual(
      expect.arrayContaining(["old-live", "new-live"]),
    );
  });
});
