export type TrailingMicrobatch = {
  schedule: () => void;
  flush: () => void;
  cancel: () => void;
};

export type LeadingTrailingMicrobatch = TrailingMicrobatch & {
  flushPending: () => void;
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

/**
 * Publishes the first update in a burst immediately, then coalesces later
 * updates behind one publication per interval until the burst goes quiet.
 */
export function createLeadingTrailingMicrobatch(
  publish: () => void,
  intervalMs: number,
): LeadingTrailingMicrobatch {
  let timer: number | undefined;
  let trailingPublicationPending = false;

  const cancel = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    trailingPublicationPending = false;
  };

  const finishInterval = () => {
    timer = undefined;
    if (!trailingPublicationPending) return;
    trailingPublicationPending = false;
    publish();
    timer = window.setTimeout(finishInterval, intervalMs);
  };

  const flush = () => {
    cancel();
    publish();
  };

  const flushPending = () => {
    const shouldPublish = trailingPublicationPending;
    cancel();
    if (shouldPublish) publish();
  };

  const schedule = () => {
    if (timer === undefined) {
      publish();
      timer = window.setTimeout(finishInterval, intervalMs);
      return;
    }
    trailingPublicationPending = true;
  };

  return { schedule, flush, flushPending, cancel };
}
