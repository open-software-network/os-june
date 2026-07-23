/** Sentinel id for the dev-only transcription-progress demo note
 * (window.__processingDemo). It lives only in the reducer. See
 * lib/processing-progress-demo.ts. */
export const PROCESSING_DEMO_NOTE_ID = "dev-processing-demo-note";

/** Sentinel session id for the dev-only recorder-notices demo
 * (window.__recordNoticesDemo). Its recording status lives only in the reducer
 * — there is no backend recording — so the pause/resume/finish handlers skip
 * it instead of calling Tauri. See
 * lib/record-notices-demo.ts. */
export const RECORD_NOTICES_DEMO_SESSION_ID = "dev-record-notices-demo-session";
