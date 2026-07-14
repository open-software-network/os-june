const sessionDispatchTails = new Map<string, Promise<void>>();

export type HermesSessionDispatchReservation = {
  /** True when another accepted Send already owns an earlier FIFO position. */
  queuedBehindPrior: boolean;
  /** Release a reservation whose preparation failed before dispatch began. */
  cancel: () => void;
  /** Wait for the reserved FIFO position, then run the dispatch section. */
  run: <Result>(dispatch: () => Promise<Result>) => Promise<Result>;
};

/**
 * Reserve one stored session's FIFO position synchronously at Send acceptance.
 * Preparation can happen after reservation without allowing a later surface to
 * overtake it. Cancelling still keeps later reservations behind every earlier
 * tail before releasing this position.
 */
export function reserveHermesSessionDispatch(
  storedSessionId: string,
): HermesSessionDispatchReservation {
  const previousTail = sessionDispatchTails.get(storedSessionId);
  const queuedBehindPrior = Boolean(previousTail);
  let releaseReservation: () => void = () => undefined;
  const reservationGate = new Promise<void>((resolve) => {
    releaseReservation = resolve;
  });
  const currentTail = (previousTail ?? Promise.resolve()).then(() => reservationGate);
  sessionDispatchTails.set(storedSessionId, currentTail);

  let state: "reserved" | "running" | "finished" = "reserved";
  const finish = () => {
    if (state === "finished") return;
    state = "finished";
    releaseReservation();
    void currentTail.then(() => {
      if (sessionDispatchTails.get(storedSessionId) === currentTail) {
        sessionDispatchTails.delete(storedSessionId);
      }
    });
  };

  return {
    queuedBehindPrior,
    cancel: () => {
      if (state === "reserved") finish();
    },
    run: async <Result>(dispatch: () => Promise<Result>): Promise<Result> => {
      if (state !== "reserved") {
        throw new Error("Hermes session dispatch reservation was already used.");
      }
      state = "running";
      await (previousTail ?? Promise.resolve());
      try {
        return await dispatch();
      } finally {
        finish();
      }
    },
  };
}

/**
 * Runs one model-configuration and prompt-submission critical section at a
 * time for a Hermes session. Dispatches for other sessions remain independent.
 */
export async function withHermesSessionDispatchLock<Result>(
  storedSessionId: string,
  dispatch: () => Promise<Result>,
): Promise<Result> {
  return reserveHermesSessionDispatch(storedSessionId).run(dispatch);
}
