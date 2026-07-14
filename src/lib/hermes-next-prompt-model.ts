import { isSessionBusyError } from "./hermes-gateway";

const DEFAULT_IDLE_WAIT_TIMEOUT_MS = 120_000;
const INITIAL_RETRY_DELAY_MS = 50;
const MAX_RETRY_DELAY_MS = 1_000;

type ApplySessionModelWhenIdleOptions = {
  timeoutMs?: number;
  wait?: (delayMs: number) => Promise<void>;
};

function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

/**
 * Hermes emits message.complete before all post-run work releases the
 * session's busy guard. Retry only that documented 4009 race; every other
 * error is a real switch failure and must block the prompt immediately.
 *
 * Goal continuations intentionally keep returning busy, which pins one model
 * for the whole user-initiated agent run. The queued choice applies only once
 * that run is truly idle, immediately before the next user prompt.
 */
export async function applySessionModelWhenIdle(
  apply: () => Promise<unknown>,
  options: ApplySessionModelWhenIdleOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_IDLE_WAIT_TIMEOUT_MS;
  const wait = options.wait ?? waitFor;
  let waitedMs = 0;
  let retryDelayMs = INITIAL_RETRY_DELAY_MS;

  while (true) {
    try {
      return await apply();
    } catch (error) {
      if (!isSessionBusyError(error) || waitedMs >= timeoutMs) throw error;
      const nextDelayMs = Math.min(retryDelayMs, timeoutMs - waitedMs);
      await wait(nextDelayMs);
      waitedMs += nextDelayMs;
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    }
  }
}
