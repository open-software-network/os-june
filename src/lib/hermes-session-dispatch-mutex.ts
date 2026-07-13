const sessionDispatchTails = new Map<string, Promise<void>>();

/**
 * Runs one model-configuration and prompt-submission critical section at a
 * time for a Hermes session. Dispatches for other sessions remain independent.
 */
export async function withHermesSessionDispatchLock<Result>(
  sessionId: string,
  dispatch: () => Promise<Result>,
): Promise<Result> {
  const previousDispatch = sessionDispatchTails.get(sessionId) ?? Promise.resolve();
  let releaseDispatch: () => void = () => undefined;
  const currentDispatch = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });

  sessionDispatchTails.set(sessionId, currentDispatch);
  await previousDispatch;

  try {
    return await dispatch();
  } finally {
    releaseDispatch();
    if (sessionDispatchTails.get(sessionId) === currentDispatch) {
      sessionDispatchTails.delete(sessionId);
    }
  }
}
