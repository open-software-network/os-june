import type { ProcessingStatus } from "../lib/tauri";

export function shouldPollProcessingStatus(status: ProcessingStatus) {
  return status === "transcribing" || status === "generating";
}

/** Sentinel id for the dev-only transcription-progress demo note
 * (window.__processingDemo). It lives only in the reducer — there is no
 * backend row — so the processing-status poll skips it. See
 * lib/processing-progress-demo.ts. */
export const PROCESSING_DEMO_NOTE_ID = "dev-processing-demo-note";

/** Sentinel session id for the dev-only recorder-notices demo
 * (window.__recordNoticesDemo). Its recording status lives only in the reducer
 * — there is no backend recording — so the recording-status poll and the
 * pause/resume/finish handlers skip it instead of calling Tauri. See
 * lib/record-notices-demo.ts. */
export const RECORD_NOTICES_DEMO_SESSION_ID = "dev-record-notices-demo-session";
