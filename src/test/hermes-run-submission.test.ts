import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  HermesGatewayError,
  HermesGatewayRequestTimeoutError,
  type HermesGatewayClient,
} from "../lib/hermes-gateway";
import { resetHermesIdleSubmitRecoveryForTests } from "../lib/hermes-idle-submit-recovery";
import { type HermesRuntimeSessionResponse, submitHermesRun } from "../lib/hermes-run-submission";

function gatewayWith(
  request: (
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>,
): HermesGatewayClient {
  return { request: vi.fn(request) } as unknown as HermesGatewayClient;
}

describe("Hermes run submission", () => {
  beforeEach(() => {
    resetHermesIdleSubmitRecoveryForTests();
  });

  it("owns the fresh named-profile run sequence through acknowledgement", async () => {
    const order: string[] = [];
    const gateway = gatewayWith(async (method) => {
      order.push(`wire:${method}`);
      if (method === "session.create") {
        return {
          stored_session_id: "stored-fresh",
          session_id: "runtime-fresh",
        } satisfies HermesRuntimeSessionResponse;
      }
      return {};
    });
    const releaseLease = vi.fn(async () => undefined);

    const result = await submitHermesRun<string>({
      fullMode: false,
      gateway,
      reconnectGateway: async () => gateway,
      shouldProbeFirstRequest: () => false,
      createSession: () => ({
        params: {
          title: "Launch plan",
          cols: 96,
          model: "__june_remote_generation__:model-a",
          reasoningEffort: "medium",
          profile: "research",
        },
        profileAssignment: {
          profile: "research",
          assign: async (storedSessionId, profile) => {
            order.push(`assign:${storedSessionId}:${profile}`);
          },
        },
      }),
      onSessionResolved: ({ storedSessionId }) => {
        order.push(`session:${storedSessionId}`);
      },
      onRuntimeSessionResolved: ({ runtimeSessionId }) => {
        order.push(`runtime:${runtimeSessionId}`);
      },
      applyThinkingLevel: () => {
        order.push("thinking");
      },
      model: {
        mode: "sandboxed",
        modelId: "__june_remote_generation__:model-a",
        shouldApply: () => true,
        onApplied: () => {
          order.push("model");
        },
      },
      attach: () => {
        order.push("attach");
      },
      preparePrompt: () => {
        order.push("prepare");
        return { text: "Review the plan." };
      },
      runLease: {
        begin: async () => {
          order.push("lease");
          return "lease-1";
        },
        release: releaseLease,
      },
      beforePrompt: () => {
        order.push("before");
      },
      afterPromptAcknowledged: () => {
        order.push("after");
      },
    });

    expect(result).toMatchObject({
      storedSessionId: "stored-fresh",
      runtimeSessionId: "runtime-fresh",
      createdUnderProfile: "research",
      promptAccepted: true,
    });
    expect(order).toEqual([
      "wire:session.create",
      "assign:stored-fresh:research",
      "session:stored-fresh",
      "runtime:runtime-fresh",
      "thinking",
      "wire:config.set",
      "model",
      "attach",
      "prepare",
      "lease",
      "before",
      "wire:prompt.submit",
      "after",
    ]);
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it("keeps Note Chat behind Agent Workspace in the shared stored-session FIFO", async () => {
    const order: string[] = [];
    let releaseWorkspaceAttach: () => void = () => undefined;
    const workspaceGateway = gatewayWith(async (method) => {
      order.push(`workspace:${method}`);
      return {};
    });
    const noteChatGateway = gatewayWith(async (method) => {
      order.push(`note-chat:${method}`);
      return {};
    });

    const workspaceSubmission = submitHermesRun({
      fullMode: false,
      gateway: workspaceGateway,
      reconnectGateway: async () => workspaceGateway,
      shouldProbeFirstRequest: () => false,
      storedSessionId: "stored-existing",
      runtimeSessionId: "runtime-existing",
      attach: async () => {
        order.push("workspace:attach");
        await new Promise<void>((resolve) => {
          releaseWorkspaceAttach = resolve;
        });
      },
      preparePrompt: () => ({ text: "Workspace first." }),
    });
    await vi.waitFor(() => expect(order).toContain("workspace:attach"));

    const noteChatSubmission = submitHermesRun({
      fullMode: false,
      gateway: noteChatGateway,
      reconnectGateway: async () => noteChatGateway,
      shouldProbeFirstRequest: () => false,
      storedSessionId: "stored-existing",
      runtimeSessionId: "runtime-existing",
      model: {
        mode: "sandboxed",
        modelId: "__june_remote_generation__:model-b",
        shouldApply: ({ dispatchReservation }) => dispatchReservation.queuedBehindPrior,
      },
      preparePrompt: () => ({ text: "Note Chat second." }),
    });

    await Promise.resolve();
    expect(order).not.toContain("note-chat:config.set");
    expect(order).not.toContain("note-chat:prompt.submit");

    releaseWorkspaceAttach();
    await expect(workspaceSubmission).resolves.toMatchObject({ promptAccepted: true });
    await expect(noteChatSubmission).resolves.toMatchObject({ promptAccepted: true });
    expect(order).toEqual([
      "workspace:attach",
      "workspace:prompt.submit",
      "note-chat:config.set",
      "note-chat:prompt.submit",
    ]);
  });

  it("resumes a stored session once before submitting on its runtime id", async () => {
    const gateway = gatewayWith(async (method) => {
      if (method === "session.resume") return { session_id: "runtime-resumed" };
      return {};
    });

    const result = await submitHermesRun({
      fullMode: false,
      gateway,
      reconnectGateway: async () => gateway,
      shouldProbeFirstRequest: () => false,
      storedSessionId: "stored-resumed",
      preparePrompt: () => ({ text: "Continue once." }),
    });

    expect(result).toMatchObject({
      storedSessionId: "stored-resumed",
      runtimeSessionId: "runtime-resumed",
      promptAccepted: true,
    });
    expect(gateway.request).toHaveBeenCalledTimes(2);
    expect(gateway.request).toHaveBeenNthCalledWith(1, "session.resume", {
      session_id: "stored-resumed",
      cols: 96,
    });
    expect(gateway.request).toHaveBeenNthCalledWith(2, "prompt.submit", {
      session_id: "runtime-resumed",
      text: "Continue once.",
    });
  });

  it("blocks prompt submission when an attachment fails", async () => {
    const gateway = gatewayWith(async () => ({}));

    await expect(
      submitHermesRun({
        fullMode: false,
        gateway,
        reconnectGateway: async () => gateway,
        shouldProbeFirstRequest: () => false,
        storedSessionId: "stored-existing",
        runtimeSessionId: "runtime-existing",
        attach: () => {
          throw new Error("attachment failed");
        },
        preparePrompt: () => ({ text: "Inspect it." }),
      }),
    ).rejects.toThrow("attachment failed");
    expect(gateway.request).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
  });

  it("waits out a busy model change before submitting the prompt", async () => {
    let modelAttempts = 0;
    const calls: string[] = [];
    const gateway = gatewayWith(async (method) => {
      calls.push(method);
      if (method === "config.set") {
        modelAttempts += 1;
        if (modelAttempts < 3) throw new HermesGatewayError("session busy", 4009);
      }
      return {};
    });

    vi.useFakeTimers();
    try {
      const submission = submitHermesRun({
        fullMode: false,
        gateway,
        reconnectGateway: async () => gateway,
        shouldProbeFirstRequest: () => false,
        storedSessionId: "stored-busy",
        runtimeSessionId: "runtime-busy",
        model: {
          mode: "sandboxed",
          modelId: "__june_remote_generation__:model-c",
          shouldApply: () => true,
        },
        preparePrompt: () => ({ text: "Use the captured model." }),
      });
      await vi.runAllTimersAsync();

      await expect(submission).resolves.toMatchObject({ promptAccepted: true });
      expect(modelAttempts).toBe(3);
      expect(calls.at(-1)).toBe("prompt.submit");
      expect(calls.filter((method) => method === "prompt.submit")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the exact run lease when prompt submission is rejected", async () => {
    const promptError = new Error("prompt rejected");
    const gateway = gatewayWith(async (method) => {
      if (method === "prompt.submit") throw promptError;
      return {};
    });
    const release = vi.fn(async () => {
      throw new Error("lease release failed");
    });

    await expect(
      submitHermesRun<string>({
        fullMode: false,
        gateway,
        reconnectGateway: async () => gateway,
        shouldProbeFirstRequest: () => false,
        storedSessionId: "stored-lease",
        runtimeSessionId: "runtime-lease",
        preparePrompt: () => ({ text: "Reject this." }),
        runLease: {
          begin: async () => "lease-1",
          release,
        },
      }),
    ).rejects.toBe(promptError);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({
        storedSessionId: "stored-lease",
        runtimeSessionId: "runtime-lease",
      }),
      "lease-1",
    );
  });

  it("keeps acknowledgement authoritative when later bookkeeping fails", async () => {
    const gateway = gatewayWith(async () => ({}));
    const bookkeepingError = new Error("monitor failed after acknowledgement");

    const result = await submitHermesRun({
      fullMode: false,
      gateway,
      reconnectGateway: async () => gateway,
      shouldProbeFirstRequest: () => false,
      storedSessionId: "stored-existing",
      runtimeSessionId: "runtime-existing",
      preparePrompt: () => ({ text: "Accepted once." }),
      afterPromptAcknowledged: () => {
        throw bookkeepingError;
      },
    });

    expect(result.promptAccepted).toBe(true);
    expect(result.postAcknowledgementError).toBe(bookkeepingError);
    expect(gateway.request).toHaveBeenCalledTimes(1);
    expect(gateway.request).toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-existing",
      text: "Accepted once.",
    });
  });

  it("retries only the idle probe before creating and submitting exactly once", async () => {
    const initialGateway = gatewayWith(async (method) => {
      if (method === "session.active_list") {
        throw new HermesGatewayRequestTimeoutError(method);
      }
      throw new Error(`Unexpected initial request: ${method}`);
    });
    const recoveredGateway = gatewayWith(async (method) => {
      if (method === "session.active_list") return { sessions: [] };
      if (method === "session.create") {
        return {
          stored_session_id: "stored-recovered",
          session_id: "runtime-recovered",
        } satisfies HermesRuntimeSessionResponse;
      }
      return {};
    });

    const result = await submitHermesRun({
      fullMode: false,
      gateway: initialGateway,
      reconnectGateway: async () => recoveredGateway,
      shouldProbeFirstRequest: () => true,
      createSession: () => ({
        params: { title: "Recovered", cols: 96 },
      }),
      preparePrompt: () => ({ text: "Submit once." }),
    });

    expect(result).toMatchObject({ promptAccepted: true });
    expect(initialGateway.request).toHaveBeenCalledOnce();
    expect(recoveredGateway.request).toHaveBeenCalledWith(
      "session.active_list",
      {},
      expect.any(Number),
    );
    expect(
      vi
        .mocked(recoveredGateway.request)
        .mock.calls.filter(([method]) => method === "session.create"),
    ).toHaveLength(1);
    expect(
      vi
        .mocked(recoveredGateway.request)
        .mock.calls.filter(([method]) => method === "prompt.submit"),
    ).toHaveLength(1);
  });
});
