import { describe, expect, it, vi } from "vitest";
import { createCompanionPublicationQueue } from "../lib/companion-publication-queue";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("companion publication queue", () => {
  it("preserves delta and lifecycle order across varying partition-check latency", async () => {
    const firstCheck = deferred<boolean>();
    const thirdCheck = deferred<boolean>();
    const checks = [
      firstCheck.promise,
      Promise.resolve(true),
      thirdCheck.promise,
      Promise.resolve(true),
    ];
    const checkPartition = vi.fn(() => checks.shift() ?? Promise.resolve(true));
    const failures = vi.fn();
    const published: string[] = [];
    const queue = createCompanionPublicationQueue({
      isSessionPublishable: checkPartition,
      onFailure: failures,
    });

    const publications = [
      queue.enqueue({
        storedSessionId: "session-1",
        eventType: "delta",
        publish: async () => {
          published.push("First ");
        },
      }),
      queue.enqueue({
        storedSessionId: "session-1",
        eventType: "delta",
        publish: async () => {
          published.push("second ");
        },
      }),
      queue.enqueue({
        storedSessionId: "session-1",
        eventType: "delta",
        publish: async () => {
          published.push("third.");
        },
      }),
      queue.enqueue({
        storedSessionId: "session-1",
        eventType: "status",
        publish: async () => {
          published.push("completed");
        },
      }),
    ];

    await Promise.resolve();
    expect(checkPartition).toHaveBeenCalledTimes(1);
    expect(published).toEqual([]);

    firstCheck.resolve(true);
    await vi.waitFor(() => {
      expect(checkPartition).toHaveBeenCalledTimes(3);
      expect(published).toEqual(["First ", "second "]);
    });

    thirdCheck.resolve(true);
    await Promise.all(publications);
    expect(checkPartition).toHaveBeenCalledTimes(4);
    expect(published).toEqual(["First ", "second ", "third.", "completed"]);
    expect(failures).not.toHaveBeenCalled();
  });

  it("reports a failed publication and keeps the session queue live", async () => {
    const error = new Error("transport unavailable");
    const failures = vi.fn();
    const published: string[] = [];
    const queue = createCompanionPublicationQueue({
      isSessionPublishable: async () => true,
      onFailure: failures,
    });

    const failed = queue.enqueue({
      storedSessionId: "session-1",
      eventType: "delta",
      publish: async () => {
        throw error;
      },
    });
    const recovered = queue.enqueue({
      storedSessionId: "session-1",
      eventType: "delta",
      publish: async () => {
        published.push("next fragment");
      },
    });

    await Promise.all([failed, recovered]);
    expect(failures).toHaveBeenCalledWith({
      error,
      eventType: "delta",
      storedSessionId: "session-1",
    });
    expect(published).toEqual(["next fragment"]);
  });
});
