import type { ProcessingStatus } from "../lib/tauri";

export function shouldPollProcessingStatus(status: ProcessingStatus) {
  return status === "transcribing" || status === "generating";
}

/** Sentinel id for the dev-only transcription-progress demo note
 * (window.__processingDemo). It lives only in the reducer — there is no
 * backend row — so the processing-status poll skips it. See
 * lib/processing-progress-demo.ts. */
export const PROCESSING_DEMO_NOTE_ID = "dev-processing-demo-note";
