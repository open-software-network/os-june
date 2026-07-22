export type TrailingMicrobatch = {
  schedule: () => void;
  flush: () => void;
  cancel: () => void;
};

/**
 * Coalesces a burst of publications behind one short trailing timer. The
 * caller keeps the authoritative value; `publish` reads that latest value
 * when the batch flushes.
 */
export function createTrailingMicrobatch(
  publish: () => void,
  intervalMs: number,
): TrailingMicrobatch {
  let timer: number | undefined;

  const cancel = () => {
    if (timer === undefined) return;
    window.clearTimeout(timer);
    timer = undefined;
  };

  const flush = () => {
    cancel();
    publish();
  };

  const schedule = () => {
    if (timer !== undefined) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      publish();
    }, intervalMs);
  };

  return { schedule, flush, cancel };
}
