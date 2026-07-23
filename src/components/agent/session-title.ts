import { errorCode } from "../../lib/errors";
import { titleFromPrompt } from "../../lib/hermes-adapter";
import { isAgentSessionTitleCandidate } from "../../lib/agent-session-titles";
import { suggestAgentSessionTitle } from "../../lib/tauri";
import { withTimeout } from "../../lib/async-timeout";
import { safeText } from "./agent-workspace-helpers";

const AGENT_TITLE_TIMEOUT_MS = 2500;
export const AGENT_TITLE_MAX_CHARS = 48;

export async function agentSessionTitleForPrompt(prompt: string, response?: string) {
  try {
    const suggestion = await withTimeout(
      suggestAgentSessionTitle(prompt, response),
      AGENT_TITLE_TIMEOUT_MS,
    );
    const title = suggestion.title.trim();
    return isAgentSessionTitleCandidate(title)
      ? { title, fromModel: true, rejected: false }
      : { title: titleFromPrompt(prompt), fromModel: false, rejected: true };
  } catch (error) {
    return {
      title: titleFromPrompt(prompt),
      fromModel: false,
      rejected: errorCode(error) === "agent_title_empty",
    };
  }
}

export function truncateAgentTitleResponseExcerpt(response: string) {
  return Array.from(response).slice(0, 1200).join("");
}

export function isReplaceableAgentSessionTitle(title: unknown) {
  const normalized = safeText(title).trim().toLowerCase();
  return (
    !normalized ||
    normalized === "untitled session" ||
    normalized.endsWith("...") ||
    normalized.length > 52 ||
    /^(?:i'm\s+|i\s+(?:want|need)\s+|please\s+|can you\s+|could you\s+|would you\s+|help me\s+|who are you|what can you|what are you|what do you|summarize\s+|set up\s+|test$)/.test(
      normalized,
    )
  );
}
