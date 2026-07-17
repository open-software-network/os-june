# Cross-surface Computer-use leases implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a non-lease-owning Note Chat run from inheriting an Agent Workspace Computer-use lease during cross-surface session handoff.

**Architecture:** Move the JavaScript lease registry out of the mounted Agent Workspace and into an app-lifetime coordinator keyed by stored session id and lease id. Note Chat awaits session-scoped lease revocation inside the existing Hermes session dispatch lane immediately before `prompt.submit`; a revocation failure aborts submission. Agent Workspace keeps generation-filtered run-start cleanup as defense in depth and uses the same coordinator for normal terminal, Stop, and unmount cleanup.

**Tech Stack:** React 18, TypeScript, Vitest, Tauri command bindings, existing Hermes session dispatch mutex.

## Global constraints

- No new package dependencies.
- A Computer-use lease exists only for a visible Agent Workspace turn that successfully called `computer_use_begin_run`.
- A non-owning surface must await native lease removal before `prompt.submit` can cross the shared session dispatch boundary.
- Revocation failure is fail-closed: the non-owning prompt is not submitted.
- Own, equal, and stale run generations must not revoke the current Workspace lease.
- Stop remains broker-first and clears all tracked leases only after native Stop succeeds.
- Preserve JUN-335 listener, resume, monitor-generation, and Stop/reconnect authority semantics.

---

### Task 1: App-lifetime lease coordinator

**Files:**
- Create: `src/lib/computer-use-run-leases.ts`
- Create: `src/test/computer-use-run-leases.test.ts`

**Interfaces:**
- Consumes: `computerUseBeginRun`, `computerUseEndRun`, and `computerUseStop` from `src/lib/tauri.ts`.
- Produces: `beginComputerUseRunLease(storedSessionId: string, leaseId: string): Promise<void>`, `releaseComputerUseRunLease(storedSessionId: string, leaseId: string): Promise<void>`, `releaseComputerUseRunsForSession(storedSessionId: string): Promise<void>`, `stopComputerUseRuns(): Promise<void>`, and `forgetComputerUseRunLeases(): void`.

- [x] **Step 1: Write failing coordinator tests**

```ts
it("awaits an in-flight release before reporting the session revoked", async () => {
  await beginComputerUseRunLease("session-1", "session-1:lease-1");
  const release = releaseComputerUseRunLease("session-1", "session-1:lease-1");
  const revoke = releaseComputerUseRunsForSession("session-1");
  expect(revoke).not.toHaveResolved();
  resolveEndRun();
  await expect(Promise.all([release, revoke])).resolves.toBeDefined();
});

it("retains a failed lease so a later fail-closed revocation retries it", async () => {
  await beginComputerUseRunLease("session-1", "session-1:lease-1");
  computerUseEndRun.mockRejectedValueOnce(new Error("native unavailable"));
  await expect(releaseComputerUseRunsForSession("session-1")).rejects.toThrow(
    "native unavailable",
  );
  await expect(releaseComputerUseRunsForSession("session-1")).resolves.toBeUndefined();
  expect(computerUseEndRun).toHaveBeenCalledTimes(2);
});
```

- [x] **Step 2: Run the coordinator tests and verify RED**

Run: `./node_modules/.bin/vitest run src/test/computer-use-run-leases.test.ts`

Expected: FAIL because `src/lib/computer-use-run-leases.ts` does not exist.

- [x] **Step 3: Implement the coordinator**

```ts
type LeaseEntry = { endPromise?: Promise<void> };
const leasesBySession = new Map<string, Map<string, LeaseEntry>>();

export async function beginComputerUseRunLease(storedSessionId: string, leaseId: string) {
  await computerUseBeginRun(leaseId);
  const leases = leasesBySession.get(storedSessionId) ?? new Map<string, LeaseEntry>();
  leases.set(leaseId, {});
  leasesBySession.set(storedSessionId, leases);
}
```

`releaseComputerUseRunLease` must share one in-flight `computerUseEndRun` promise per lease, delete the entry only after success, and clear `endPromise` after failure so a later caller retries. `releaseComputerUseRunsForSession` must snapshot all entries and await every release. `stopComputerUseRuns` must await `computerUseStop` before clearing the registry. `forgetComputerUseRunLeases` clears only the JavaScript registry after native state is already known to be stopped.

- [x] **Step 4: Run the coordinator tests and verify GREEN**

Run: `./node_modules/.bin/vitest run src/test/computer-use-run-leases.test.ts`

Expected: PASS.

---

### Task 2: Route Workspace lifecycle through the coordinator

**Files:**
- Modify: `src/components/agent/AgentWorkspace.tsx:88-100,3631-3635,4196-4231,8253-8274,9961-10100,12684-12770`
- Modify: `src/test/agent-workspace.test.tsx:61-180,13426-13603,17714-17745`

**Interfaces:**
- Consumes: all five coordinator exports from Task 1.
- Produces: no new public API; Agent Workspace no longer owns a component-local lease map.

- [x] **Step 1: Extend the existing supersession regression**

Keep the test `releases Computer use when a newer cross-surface run supersedes the Workspace turn`, and assert an own-generation announcement does not call `computerUseEndRun` before a newer generation does.

- [x] **Step 2: Run the regression and preserve RED/GREEN evidence**

Run: `./node_modules/.bin/vitest run src/test/agent-workspace.test.tsx -t "releases Computer use when a newer cross-surface run supersedes the Workspace turn"`

Expected before Task 1 wiring: FAIL or retain the already-recorded RED result with zero `computerUseEndRun` calls. Expected after wiring: PASS.

- [x] **Step 3: Replace local lease helpers**

Remove `computerUseRunLeasesRef`, `rememberComputerUseRun`, and the local release helpers. Begin a turn with `await beginComputerUseRunLease(storedSessionId, computerUseRunLeaseId)`. Use coordinator release functions in submit failure, supersession, terminal, monitor, persisted-idle, and run-start cleanup. Use `stopComputerUseRuns()` for explicit Stop and unmount, preserving broker-before-interrupt ordering.

- [x] **Step 4: Run Workspace tests**

Run: `./node_modules/.bin/vitest run src/test/agent-workspace.test.tsx`

Expected: 434 passing tests and 2 skipped tests or a later higher passing count with zero failures.

---

### Task 3: Revoke before non-owning Note Chat dispatch

**Files:**
- Modify: `src/components/note-chat/useNoteChat.ts:3550-3620`
- Modify: `src/test/note-chat-sessions.test.ts`

**Interfaces:**
- Consumes: `releaseComputerUseRunsForSession(storedSessionId: string): Promise<void>` from Task 1.
- Produces: a fail-closed pre-submit barrier inside the existing session dispatch reservation.

- [x] **Step 1: Write a failing Note Chat ordering test**

Register `session-1:workspace-lease` through the real coordinator with mocked Tauri bindings. Hold `computerUseEndRun` pending, submit a Note Chat prompt, and assert `prompt.submit` has not been called. Resolve native end-run, then assert `computerUseEndRun("session-1:workspace-lease")` occurs before `prompt.submit`.

- [x] **Step 2: Run the Note Chat test and verify RED**

Run: `./node_modules/.bin/vitest run src/test/note-chat-sessions.test.ts -t "revokes the Workspace Computer-use lease before Note Chat submits"`

Expected: FAIL because `prompt.submit` occurs while native end-run is still pending.

- [x] **Step 3: Add the dispatch barrier**

```ts
await releaseComputerUseRunsForSession(activeStoredSessionId);
await gateway.request("prompt.submit", {
  session_id: activeRuntimeSessionId,
  text: content,
});
```

Place both calls inside the existing `dispatchReservation.run` callback. Do not catch revocation locally; the existing submission failure path must prevent the prompt and restore UI continuity.

- [x] **Step 4: Run Note Chat tests and verify GREEN**

Run: `./node_modules/.bin/vitest run src/test/note-chat-sessions.test.ts -t "revokes the Workspace Computer-use lease before Note Chat submits"`

Expected: PASS.

---

### Task 4: Final verification and review

**Files:**
- Verify all files staged in the active merge.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: a conflict-free, review-clean merge candidate.

- [x] **Step 1: Run deterministic frontend gates**

Run: `./node_modules/.bin/tsc --noEmit`

Run: `./node_modules/.bin/biome check .`

Run: `./node_modules/.bin/vitest run`

Expected: typecheck and Biome exit 0; all Vitest files pass with only the repository's known jsdom/React warnings.

- [x] **Step 2: Re-run merge invariants**

Run: `git diff --name-only --diff-filter=U`

Run: `git diff --cached --check`

Run: `rg --hidden -n '^(<<<<<<<|=======|>>>>>>>)' . --glob '!.git/**'`

Expected: no unmerged paths, whitespace errors, or conflict markers.

- [x] **Step 3: Re-run adversarial review**

Ask the original frontend integration reviewer to verify that pre-submit revocation completes before Note Chat can enter Hermes and that own/stale generation handling remains intact.

- [x] **Step 4: Complete and push the merge**

Commit the active merge, fetch and verify current `origin/main`, push `codex/jun-335-stable-streaming`, and confirm PR #797 no longer conflicts.
