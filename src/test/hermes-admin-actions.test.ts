import { describe, expect, it } from "vitest";
import { HermesAdminError } from "../lib/hermes-admin";
import type { HermesActionStatus } from "../lib/hermes-admin";
import {
  instantSleep,
  makeAdminHarness,
} from "./fixtures/hermes-admin-harness";
import {
  pendingSkillWritesScenario,
  skillSecurityWarningScenario,
} from "./fixtures/hermes-admin-scenarios";

describe("background action polling", () => {
  it("a backgrounded hub install returns an action handle to poll", async () => {
    const { client } = makeAdminHarness(pendingSkillWritesScenario());
    const outcome = await client.skills.hubInstall("research");
    // backgroundActions: true -> the install returns an action.
    expect(outcome.action).toBeDefined();
    expect(outcome.appliesAt).toBe("next-session");
  });

  it("polls an action from queued/running through to succeeded", async () => {
    const { client } = makeAdminHarness(pendingSkillWritesScenario());
    const { action } = await client.skills.hubUpdate("drafted-by-agent");
    expect(action).toBeDefined();

    const seen: HermesActionStatus[] = [];
    const final = await client.pollAction(action!, {
      sleep: instantSleep,
      onStatus: (status) => seen.push(status),
    });

    // The scripted progression is queued -> running -> succeeded.
    expect(seen.map((s) => s.state)).toEqual([
      "queued",
      "running",
      "succeeded",
    ]);
    expect(final.state).toBe("succeeded");
    expect(final.done).toBe(true);
    expect(final.progress).toBe(100);
  });

  it("returns the failed status (does not throw) when an action fails", async () => {
    // The security scenario's install action fails.
    const { client } = makeAdminHarness(skillSecurityWarningScenario());
    const { action } = await client.skills.hubInstall(
      "https://example.test/raw/SKILL.md",
    );
    const final = await client.pollAction(action!, { sleep: instantSleep });
    expect(final.state).toBe("failed");
    expect(final.done).toBe(true);
    expect(final.error).toContain("security review");
  });

  it("times out (rejecting with a timeout error) if the action never finishes", async () => {
    const { client } = makeAdminHarness({
      token: "fake-token-stuck",
      backgroundActions: true,
      actionScripts: {
        update: { states: [{ state: "running", progress: 10 }] },
      },
      skills: [{ name: "x", enabled: false, source: "hub" }],
    });
    const { action } = await client.skills.hubUpdate("x");
    const error = await client
      .pollAction(action!, {
        sleep: instantSleep,
        intervalMs: 10,
        timeoutMs: 25,
      })
      .then(
        () => undefined,
        (e: unknown) => e as HermesAdminError,
      );
    expect(error).toBeInstanceOf(HermesAdminError);
    expect(error?.kind).toBe("timeout");
  });

  it("stops polling when the abort signal fires", async () => {
    const { client } = makeAdminHarness({
      token: "fake-token-abort",
      backgroundActions: true,
      actionScripts: {
        update: { states: [{ state: "running", progress: 10 }] },
      },
      skills: [{ name: "x", enabled: false, source: "hub" }],
    });
    const { action } = await client.skills.hubUpdate("x");
    const controller = new AbortController();
    controller.abort();
    const error = await client
      .pollAction(action!, { sleep: instantSleep, signal: controller.signal })
      .then(
        () => undefined,
        (e: unknown) => e as HermesAdminError,
      );
    expect(error?.kind).toBe("timeout");
  });

  it("resolves immediately when a mutation completes synchronously (no action handle)", async () => {
    // backgroundActions defaults to false: the install completes synchronously.
    const { client } = makeAdminHarness({
      token: "fake-token-sync",
      skills: [{ name: "x", enabled: false, source: "hub" }],
      hubResults: [{ identifier: "x" }],
    });
    const outcome = await client.skills.hubInstall("x");
    expect(outcome.action).toBeUndefined();
    expect(outcome.result).toBeUndefined();
  });

  it("polls a single action handle via actions.status without looping", async () => {
    const { client } = makeAdminHarness(pendingSkillWritesScenario());
    const { action } = await client.skills.hubUpdate("drafted-by-agent");
    const first = await client.actions.status(action!);
    // First poll of the queued->running->succeeded script.
    expect(first.state).toBe("queued");
    expect(first.done).toBe(false);
  });
});
