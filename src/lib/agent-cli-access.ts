/** The literal token June emits when an agent CLI fails because the sandbox
 * blocks its state folders. The agent can never flip the setting itself: the
 * flag file lives outside every sandbox write root by design, so the request
 * is rendered as a card the user approves with one click. */
export const AGENT_CLI_ACCESS_REQUEST_TOKEN = "[REQUEST:AGENT_CLI_ACCESS]";

export function hasAgentCliAccessRequest(text: string) {
  return text.includes(AGENT_CLI_ACCESS_REQUEST_TOKEN);
}

/** Removes the request token (and the blank line it sat on) from display
 * text; the card renders in its place. */
export function stripAgentCliAccessRequest(text: string) {
  return text
    .split(AGENT_CLI_ACCESS_REQUEST_TOKEN)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Sent into the session after the user approves the request, so June knows
 * the grant is live and retries after the agent harness restarts. */
export const AGENT_CLI_ACCESS_ENABLED_MESSAGE =
  "I enabled Agent CLI access. The session now has write access to the CLI state folders; try the CLI again.";
