import { experimentalBrowserUseEnabled } from "./experimental-flags";

/** The literal token June's soul tells it to emit when a task needs Browser
 * use while the Browser access grant is off (JUNE_SOUL_BROWSER_BLOCKED_MD in
 * src-tauri/src/hermes_bridge.rs — the two must stay in sync). The agent can
 * never flip the setting itself: the flag file lives outside every sandbox
 * write root by design, so the request is rendered as a card the user
 * approves with one click. */
export const BROWSER_ACCESS_REQUEST_TOKEN = "[REQUEST:BROWSER_ACCESS]";

/** True when the text carries the request token and Browser use exists in
 * this build. While the feature flag is off no card must render (the setting
 * it would enable is hidden), but the strip below still runs so a stray
 * token never shows as literal text. */
export function hasBrowserAccessRequest(text: string) {
  return experimentalBrowserUseEnabled() && text.includes(BROWSER_ACCESS_REQUEST_TOKEN);
}

/** Removes the request token (and the blank line it sat on) from display
 * text; the card renders in its place. */
export function stripBrowserAccessRequest(text: string) {
  return text
    .split(BROWSER_ACCESS_REQUEST_TOKEN)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Sent into the session after the user approves the request, so June knows
 * the grant is live and retries on the freshly restarted runtime. */
export const BROWSER_ACCESS_ENABLED_MESSAGE =
  "I enabled Browser use. The session can now drive the browser through the june_browser tools; try the browser task again.";
