import { IconBranchSimple } from "central-icons/IconBranchSimple";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconExclamationTriangle } from "central-icons/IconExclamationTriangle";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconShieldCrossed } from "central-icons/IconShieldCrossed";
import { useEffect, useId, useState } from "react";
import type { AgentChatPart, AgentChatTurn } from "../../../lib/agent-chat-runtime";
import { isBranchableMessageId } from "../../../lib/hermes-session-branch";
import { isSensitiveKey, type HermesMode } from "../../../lib/hermes-control-plane";
import type { HermesSessionMessage } from "../../../lib/tauri";
import { DotSpinner } from "../../DotSpinner";
import { HoverTip } from "../../ui/HoverTip";
import { InlineNotice } from "../../ui/InlineNotice";
import { CollapsibleActionCard, ResolvedActionRow } from "./ActionCardPrimitives";

export const TURN_ACTION_TIP_DELAY_MS = 550;

export function branchSourceSessionIdForTurn(turn: Pick<AgentChatTurn, "parts">) {
  for (const part of turn.parts) {
    if (!("sessionId" in part)) continue;
    const sessionId = part.sessionId?.trim();
    if (sessionId) return sessionId;
  }
  return undefined;
}

/** Whether a turn is a concrete message — the only kind that carries per-turn
 * affordances (copy / branch / timestamp). A user message always qualifies; an
 * assistant turn qualifies once it has produced a real answer: non-empty text
 * or a finished image. Everything else is process or interaction — thinking in
 * progress, tool calls, approval/clarify/sudo/secret cards, context summaries,
 * in-flight/empty turns — and gets nothing below it. An allowlist (not a
 * per-type blocklist) so new process/card part types stay quiet by default. */
export function turnIsConcreteResponse(turn: Pick<AgentChatTurn, "role" | "parts">) {
  if (turn.role === "user") return true;
  return turn.parts.some(
    (part) =>
      (part.type === "text" && part.text.trim().length > 0) ||
      (part.type === "image" && part.status === "complete"),
  );
}

export function previousBranchableMessageIndex(
  messages: HermesSessionMessage[],
  beforeIndex: number,
) {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role !== "tool" && isBranchableMessageId(message.id)) return index;
  }
  return -1;
}

function lastBranchableMessageIndex(messages: HermesSessionMessage[]) {
  return previousBranchableMessageIndex(messages, messages.length);
}

function latestBranchableUserMessageIndex(messages: HermesSessionMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && isBranchableMessageId(message.id)) return index;
  }
  return -1;
}

export function liveAssistantBranchPointIndex(
  messages: HermesSessionMessage[],
  pendingMessages: HermesSessionMessage[],
) {
  if (pendingMessages.some((message) => message.role === "user")) {
    return lastBranchableMessageIndex(messages);
  }
  const latestUserIndex = latestBranchableUserMessageIndex(messages);
  if (latestUserIndex >= 0) {
    return previousBranchableMessageIndex(messages, latestUserIndex);
  }
  return lastBranchableMessageIndex(messages);
}

export function isLiveAssistantTurnId(id: string) {
  return id.startsWith("assistant:");
}

function canRequestBranchFromTurnId(id: string) {
  return isBranchableMessageId(id) || id.startsWith("pending:user:") || isLiveAssistantTurnId(id);
}

/** The per-message "Branch from here" action (feature 07). Forks the
 * conversation into a NEW session that starts from this message, leaving the
 * source session untouched. Persisted turns branch exactly at their Hermes
 * message id; pending user prompts and live assistant rows are still actionable
 * because the workspace can resolve them to the nearest saved fork point.
 * Other synthetic rows stay clickable but announce why branching is not
 * available yet instead of swallowing the click as a silent no-op (JUN-182).
 * The branch itself flows through the typed `branchSession` method via
 * `onBranch`. */
export function BranchFromHereAction({
  messageId,
  onBranch,
  sessionId,
  submitting,
}: {
  messageId: string;
  onBranch: (messageId: string, sessionId?: string) => void;
  sessionId?: string;
  submitting?: boolean;
}) {
  const branchable = canRequestBranchFromTurnId(messageId);
  const action = (
    <button
      type="button"
      className="agent-turn-action"
      aria-label={submitting ? "Creating branch" : "Branch from here"}
      // Truly inert only while a fork is in flight. A non-branchable turn
      // announces itself disabled but stays clickable, so the click still
      // reaches onBranch and the handler explains why branching isn't
      // available yet instead of failing silently (JUN-182).
      aria-disabled={!branchable || undefined}
      aria-busy={submitting || undefined}
      disabled={submitting}
      onClick={() => onBranch(messageId, sessionId)}
    >
      {submitting ? <DotSpinner /> : <IconBranchSimple size={14} aria-hidden />}
    </button>
  );

  if (submitting) {
    return action;
  }

  const tip = branchable ? "Branch from here" : "Branching is available once the message is saved";
  return (
    <HoverTip
      compact
      width={branchable ? 136 : 216}
      delay={TURN_ACTION_TIP_DELAY_MS}
      // The unavailable reason is honest, not silent: a synthetic/in-flight
      // turn has no persisted id Hermes can fork from yet.
      tip={tip}
      className="agent-turn-action-tip"
    >
      {action}
    </HoverTip>
  );
}

/** A privilege-escalation prompt (`sudo.request`). Approval is EXPLICIT: the
 * card surfaces the command and reason Hermes gave (degrading gracefully when
 * either is absent) and shows the execution mode so the user understands the
 * blast radius before granting. Resolution flows through the typed
 * `respondToSudo` method. Mirrors the approval card chrome. */
export function SudoPart({
  onSudo,
  part,
  submitting,
}: {
  onSudo: (part: Extract<AgentChatPart, { type: "sudo" }>, approved: boolean) => void;
  part: Extract<AgentChatPart, { type: "sudo" }>;
  submitting?: "approve" | "deny";
}) {
  const disabled = Boolean(submitting) || part.status !== "pending";
  // A card that has actually resolved collapses to a receipt row. A submission
  // still in flight (submitting set, status pending) keeps the card.
  const resolved = part.status !== "pending";
  const showResult = resolved || submitting !== undefined;
  // The whole card is compact by default; expanding reveals the full body.
  const [expanded, setExpanded] = useState(false);
  // Absent mode defaults to the safe direction (sandboxed) so the card never
  // implies more access than is being granted.
  const mode: HermesMode = part.mode ?? "sandboxed";
  const unrestricted = mode === "unrestricted";
  const decided = part.approved ?? (submitting ? submitting === "approve" : undefined);

  const modeCopy = unrestricted
    ? "Will run unrestricted (full write access)"
    : "Will run sandboxed (limited write access)";

  // Pending: the blast radius shows as an InlineNotice — warning chrome for
  // unrestricted, neutral for sandboxed.
  const modeNotice = (
    <InlineNotice
      className="agent-sudo-mode-notice"
      tone={unrestricted ? "warning" : "info"}
      icon={
        unrestricted ? (
          <IconShieldCrossed size={14} aria-hidden />
        ) : (
          <IconShieldCheck size={14} aria-hidden />
        )
      }
      body={modeCopy}
    />
  );

  // Receipt: the same mode line, but as quiet plain text — receipts carry no
  // notice chrome.
  const modeReceiptLine = (
    <p className="agent-sudo-mode-receipt" data-mode={mode}>
      {modeCopy}
    </p>
  );

  // Collapsed pending: the full InlineNotice lives behind Details, so the header
  // still has to carry the blast radius at the moment of decision — but only for
  // the unrestricted (elevated) case. A small warning badge pinned in the header
  // row does it. Sandboxed is the safe default and shows no collapsed badge (the
  // full mode line still appears in Details for both).
  const modeBadge = unrestricted ? (
    <span className="agent-sudo-mode-badge">
      <IconExclamationTriangle size={12} aria-hidden />
      Unrestricted
    </span>
  ) : null;

  // Resolved collapses to a quiet receipt row: "Approved"/"Denied" plus the
  // command, expandable to the reason, command, and execution mode.
  if (resolved) {
    return (
      <ResolvedActionRow
        denied={!decided}
        label={decided ? "Approved" : "Denied"}
        detail={
          part.command ? <span className="agent-resolved-mono">{part.command}</span> : undefined
        }
      >
        <p>{part.reason ?? "June needs elevated permissions before it can continue."}</p>
        {part.command ? <pre>{part.command}</pre> : null}
        {modeReceiptLine}
      </ResolvedActionRow>
    );
  }

  const reason = part.reason ?? "June needs elevated permissions before it can continue.";

  const footer = showResult ? (
    <p className="agent-approval-result" data-choice={decided ? "once" : "deny"}>
      {decided ? <IconCheckmark2Small size={14} /> : <IconCrossMedium size={14} />}
      {decided ? (submitting ? "Approving" : "Approved") : submitting ? "Denying" : "Denied"}
    </p>
  ) : (
    // Sudo keeps a simple Approve/Deny pair.
    <div className="agent-approval-actions">
      <button
        type="button"
        className="btn btn-secondary"
        disabled={disabled}
        onClick={() => onSudo(part, true)}
      >
        Approve
      </button>
      <button
        type="button"
        className="btn btn-ghost agent-approval-deny"
        disabled={disabled}
        onClick={() => onSudo(part, false)}
      >
        Deny
      </button>
    </div>
  );

  return (
    <CollapsibleActionCard
      title="Privilege escalation requested"
      description={reason}
      headerMeta={modeBadge}
      command={part.command ? <pre>{part.command}</pre> : null}
      // Command is always visible; Details reveals the fuller mode notice (the
      // blast-radius badge already shows collapsed).
      hasDetails={true}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((value) => !value)}
      footer={footer}
    >
      {modeNotice}
    </CollapsibleActionCard>
  );
}

/** A `secret.request` prompt. SECURITY: the entered value lives ONLY in this
 * component's local state, is sent straight to the gateway via the typed
 * `respondToSecret` method, and is wiped on submit, cancel, and unmount. It is
 * never logged, never placed on a part/event, and never echoed (the input is a
 * password field). The requested key name is redacted when it looks sensitive
 * so a token name can't leak into the transcript either. */
export function SecretPart({
  onSecret,
  onCancel,
  part,
  submitting,
}: {
  onSecret: (part: Extract<AgentChatPart, { type: "secret" }>, value: string) => void;
  onCancel?: (part: Extract<AgentChatPart, { type: "secret" }>) => void;
  part: Extract<AgentChatPart, { type: "secret" }>;
  submitting?: true;
}) {
  const [value, setValue] = useState("");
  const inputId = useId();
  const disabled = part.status !== "pending" || submitting !== undefined;
  const label = part.keyName ? redactedKeyName(part.keyName) : undefined;

  // Defense in depth: clear the entered value if the card unmounts (navigation,
  // resolution) so it never lingers in a detached React tree.
  useEffect(() => {
    return () => setValue("");
  }, []);

  function submit() {
    const entered = value;
    if (!entered) return;
    // Hand the value off, then immediately wipe local state — the value never
    // outlives the submit call here.
    onSecret(part, entered);
    setValue("");
  }

  function cancel() {
    setValue("");
    onCancel?.(part);
  }

  const keyLine = label ? (
    <p className="agent-secret-key">
      <span>Key</span>
      <code>{label}</code>
    </p>
  ) : null;

  // Resolved collapses to a quiet receipt row: "Secret provided" plus the
  // redacted key name (never the value), expandable to the reason and key.
  // SECURITY: no secret value is ever rendered here — only the reason and the
  // already-redacted key label.
  if (part.status !== "pending") {
    return (
      <ResolvedActionRow
        label="Secret provided"
        detail={label ? <span className="agent-resolved-mono">{label}</span> : undefined}
      >
        <p>{part.reason ?? "June needs a secret value before it can continue."}</p>
        {keyLine}
      </ResolvedActionRow>
    );
  }

  return (
    <article className="agent-approval-card" data-status={part.status}>
      <div>
        <div className="agent-tool-title">
          <span>Secret requested</span>
        </div>
        <p>{part.reason ?? "June needs a secret value before it can continue."}</p>
        {keyLine}
        <form
          className="agent-secret-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label htmlFor={inputId} className="agent-secret-label">
            Secret value
          </label>
          <input
            id={inputId}
            type="password"
            className="dialog-input agent-secret-input"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            // The browser must never store or suggest this value.
            data-1p-ignore
            data-lpignore="true"
            disabled={disabled}
            value={value}
            placeholder="Paste the value"
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          <p className="agent-secret-note">
            Sent straight to the agent and never saved, logged, or shown.
          </p>
          <div className="agent-approval-actions">
            <button type="submit" className="btn btn-secondary" disabled={disabled || !value}>
              {submitting ? "Submitting" : "Submit"}
            </button>
            <button
              type="button"
              className="btn btn-ghost agent-approval-deny"
              disabled={submitting !== undefined}
              onClick={cancel}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </article>
  );
}

/** Masks a requested key name when it matches the shared sensitive-key pattern
 * (TOKEN, API_KEY, SECRET, PASSWORD, PRIVATE_KEY, CREDENTIAL), so even the
 * label can't leak a token name into the transcript. Benign names (e.g.
 * GITHUB_USERNAME) pass through unchanged. */
function redactedKeyName(keyName: string) {
  return isSensitiveKey(keyName) ? "[redacted]" : keyName;
}
