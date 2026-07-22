import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconLightBulbSimple } from "central-icons/IconLightBulbSimple";
import { useId, useState } from "react";
import type { AgentApprovalChoice, AgentChatPart } from "../../../lib/agent-chat-runtime";
import { explainAgentApproval, type PendingBrowserApproval } from "../../../lib/tauri";
import { Spinner } from "../../ui/Spinner";
import {
  ApproveSplitButton,
  CollapsibleActionCard,
  ResolvedActionRow,
} from "./ActionCardPrimitives";

export function ClarifyPart({
  onClarify,
  part,
  submitting,
}: {
  onClarify: (part: Extract<AgentChatPart, { type: "clarify" }>, answer: string) => void;
  part: Extract<AgentChatPart, { type: "clarify" }>;
  submitting?: string;
}) {
  const [typing, setTyping] = useState(part.choices.length === 0);
  const [draft, setDraft] = useState("");
  const disabled = part.status !== "pending" || submitting !== undefined;

  // Resolved clarify collapses to a quiet receipt row: "Answered" (or "Skipped")
  // plus the question, expandable to the full question and answer.
  if (part.status !== "pending") {
    const answered = Boolean(part.answer?.trim());
    return (
      <ResolvedActionRow label={answered ? "Answered" : "Skipped"} detail={part.question}>
        <p>{part.question}</p>
        {answered ? <p className="agent-clarify-answer">{part.answer}</p> : null}
      </ResolvedActionRow>
    );
  }

  return (
    <article className="agent-clarify-card" data-status={part.status}>
      <div>
        <div className="agent-tool-title">
          <span>Clarify</span>
        </div>
        <p className="agent-clarify-question">{part.question}</p>
        {part.status === "pending" ? (
          <>
            {!typing && part.choices.length ? (
              <div className="agent-clarify-choices">
                {part.choices.map((choice, index) => (
                  <button
                    type="button"
                    key={`${index}:${choice}`}
                    disabled={disabled}
                    onClick={() => onClarify(part, choice)}
                  >
                    <span>{index + 1}</span>
                    {choice}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={submitting !== undefined}
                  onClick={() => setTyping(true)}
                >
                  <span>+</span>
                  Other
                </button>
              </div>
            ) : null}
            {typing || !part.choices.length ? (
              <form
                className="agent-clarify-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const answer = draft.trim();
                  if (answer) onClarify(part, answer);
                }}
              >
                <textarea
                  className="dialog-textarea agent-clarify-textarea"
                  value={draft}
                  disabled={disabled}
                  rows={3}
                  placeholder="Type your answer"
                  onChange={(event) => setDraft(event.currentTarget.value)}
                />
                <div>
                  {part.choices.length ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={submitting !== undefined}
                      onClick={() => {
                        setDraft("");
                        setTyping(false);
                      }}
                    >
                      Back
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={disabled}
                    onClick={() => onClarify(part, "")}
                  >
                    Skip
                  </button>
                  <button
                    type="submit"
                    className="btn btn-secondary"
                    disabled={disabled || !draft.trim()}
                  >
                    {submitting !== undefined ? "Sending" : "Send"}
                  </button>
                </div>
              </form>
            ) : null}
          </>
        ) : null}
      </div>
    </article>
  );
}

export type AgentCliAccessCardProps = {
  /** undefined while the stored setting is still loading. */
  enabled?: boolean;
  submitting: boolean;
  onEnable: () => void;
};

/** June asked to enable "Agent CLI access" via the literal token its soul
 * teaches ([REQUEST:AGENT_CLI_ACCESS]). The agent can never flip the setting
 * itself — the flag file sits outside every sandbox write root — so this
 * card is the one-click, user-approved path. Resolution is derived from the
 * live setting rather than stored per message: a revisited transcript shows
 * "Enabled" once the grant is on, and re-offers the choice while it is off.
 * Mirrors the approval card chrome. */
export function AgentCliAccessCard({ cliAccess }: { cliAccess?: AgentCliAccessCardProps }) {
  const [dismissed, setDismissed] = useState(false);
  const enabled = cliAccess?.enabled === true;
  const resolved = enabled || dismissed;
  const busy = Boolean(cliAccess?.submitting);

  const description = (
    <p>
      June wants write access to the state folders of your coding CLIs (Claude Code, Codex, Gemini,
      opencode) so they stay logged in and can save their work in sandboxed sessions. Those folders
      configure software that also runs outside June's sandbox. Enabling turns on "Agent CLI access"
      in Settings and restarts the sandboxed runtime.
    </p>
  );

  // Resolved collapses to a quiet receipt row, expandable to the description.
  if (resolved) {
    return (
      <ResolvedActionRow denied={!enabled} label={enabled ? "Agent CLI access enabled" : "Not now"}>
        {description}
      </ResolvedActionRow>
    );
  }

  return (
    <article className="agent-approval-card" data-status="pending">
      <div>
        <div className="agent-tool-title">
          <span>Agent CLI access requested</span>
        </div>
        {description}
        <div className="agent-approval-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !cliAccess || cliAccess.enabled === undefined}
            onClick={() => cliAccess?.onEnable()}
          >
            {busy ? "Enabling…" : "Enable Agent CLI access"}
          </button>
          <button
            type="button"
            className="btn btn-ghost agent-approval-deny"
            disabled={busy}
            onClick={() => setDismissed(true)}
          >
            Not now
          </button>
        </div>
      </div>
    </article>
  );
}

export type AgentBrowserAccessCardProps = {
  /** undefined while the stored grant is still loading. */
  enabled?: boolean;
  submitting: boolean;
  onEnable: () => void;
};

export function BrowserApprovalCard({
  approval,
  submitting,
  onRespond,
}: {
  approval: PendingBrowserApproval;
  submitting: boolean;
  onRespond: (approve: boolean, allowSite: boolean) => void;
}) {
  const action = approval.action.charAt(0).toUpperCase() + approval.action.slice(1);
  return (
    <article className="agent-approval-card" data-status="pending">
      <div className="agent-tool-title">
        <span>Browser approval required</span>
      </div>
      <p>
        Site: {approval.site}
        {"\n"}
        Action: {action}
        {"\n"}
        Element: {approval.elementLabel}
      </p>
      <div className="agent-approval-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={submitting}
          onClick={() => onRespond(true, false)}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={submitting}
          onClick={() => onRespond(true, true)}
        >
          Approve all on this site for this task
        </button>
        <button
          type="button"
          className="btn btn-ghost agent-approval-deny"
          disabled={submitting}
          onClick={() => onRespond(false, false)}
        >
          Decline
        </button>
      </div>
    </article>
  );
}

/** June asked to enable Browser use via the literal token its soul teaches
 * ([REQUEST:BROWSER_ACCESS]). The agent can never flip the setting itself —
 * the Browser access grant is a flag file outside every sandbox write root —
 * so this card is the one-click, user-approved path. Resolution is derived
 * from the live grant rather than stored per message, exactly like the Agent
 * CLI access card above: a revisited transcript shows "Enabled" once the
 * grant is on, and re-offers the choice while it is off. */
export function AgentBrowserAccessCard({
  browserAccess,
}: {
  browserAccess?: AgentBrowserAccessCardProps;
}) {
  const [dismissed, setDismissed] = useState(false);
  const enabled = browserAccess?.enabled === true;
  const resolved = enabled || dismissed;
  const busy = Boolean(browserAccess?.submitting);

  const description = (
    <p>
      June wants to drive your browser to finish this task, in tabs it opens and tabs you explicitly
      share. Page content from those tabs (visible text and screenshots) leaves this device and is
      sent to your configured AI model for inference. Enabling turns on "Browser use" in Settings
      and restarts the agent runtime.
    </p>
  );

  // Resolved collapses to a quiet receipt row, expandable to the description.
  if (resolved) {
    return (
      <ResolvedActionRow denied={!enabled} label={enabled ? "Browser use enabled" : "Not now"}>
        {description}
      </ResolvedActionRow>
    );
  }

  return (
    <article className="agent-approval-card" data-status="pending">
      <div>
        <div className="agent-tool-title">
          <span>Browser use requested</span>
        </div>
        {description}
        <div className="agent-approval-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !browserAccess || browserAccess.enabled === undefined}
            onClick={() => browserAccess?.onEnable()}
          >
            {busy ? "Enabling…" : "Enable Browser use"}
          </button>
          <button
            type="button"
            className="btn btn-ghost agent-approval-deny"
            disabled={busy}
            onClick={() => setDismissed(true)}
          >
            Not now
          </button>
        </div>
      </div>
    </article>
  );
}

export function ApprovalPart({
  onApproval,
  part,
  submitting,
}: {
  onApproval: (
    part: Extract<AgentChatPart, { type: "approval" }>,
    choice: AgentApprovalChoice,
  ) => void;
  part: Extract<AgentChatPart, { type: "approval" }>;
  submitting?: AgentApprovalChoice;
}) {
  const disabled = Boolean(submitting) || part.status !== "pending";
  const activeChoice = part.choice ?? submitting;
  // A card that has actually resolved collapses to a receipt row. A submission
  // still in flight (submitting set, status pending) keeps the card so the
  // in-progress line ("Approving once") stays visible until it resolves.
  const resolved = part.status !== "pending";
  const showResult = resolved || activeChoice !== undefined;
  // The whole card is compact by default; expanding reveals the full body.
  const [expanded, setExpanded] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  // "Explain first" asks the generation model what this specific request
  // would do — the request stays parked, nothing is approved by asking.
  // The answer is cached for the card's lifetime; an error retries on the
  // next open and falls back to static copy meanwhile.
  const [explanation, setExplanation] = useState<string>();
  const [explainState, setExplainState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const explanationId = useId();

  function toggleExplain() {
    const nextOpen = !explainOpen;
    setExplainOpen(nextOpen);
    // Opening the explanation auto-expands the card so the panel has room.
    if (nextOpen) setExpanded(true);
    if (!nextOpen || explainState === "loading" || explainState === "ready") {
      return;
    }
    setExplainState("loading");
    explainAgentApproval({
      description: part.description,
      command: part.command || undefined,
    })
      .then((response) => {
        setExplanation(response.explanation);
        setExplainState("ready");
      })
      .catch(() => {
        setExplainState("error");
      });
  }

  // Resolved collapses to a quiet receipt row: the outcome label plus the
  // command (or description) truncated to one line, expandable to the full
  // description and command — no action buttons.
  if (resolved) {
    if (part.status === "expired") {
      const outcomeUnconfirmed = part.retiredReason === "unconfirmed";
      return (
        <ResolvedActionRow
          denied={!outcomeUnconfirmed}
          unknown={outcomeUnconfirmed}
          label={outcomeUnconfirmed ? "Approval outcome unknown" : "Approval expired"}
          detail={
            part.command ? (
              <span className="agent-resolved-mono">{part.command}</span>
            ) : (
              part.description
            )
          }
        >
          {outcomeUnconfirmed ? (
            <p>
              The connection closed before June could confirm the response. This approval is no
              longer actionable, but it may have already been applied. Check the agent activity
              before retrying.
            </p>
          ) : (
            <p>This approval is no longer pending. June did not approve anything.</p>
          )}
          {part.command ? <pre>{part.command}</pre> : null}
        </ResolvedActionRow>
      );
    }
    return (
      <ResolvedActionRow
        denied={activeChoice === "deny"}
        label={approvalChoiceLabel(activeChoice)}
        detail={
          part.command ? (
            <span className="agent-resolved-mono">{part.command}</span>
          ) : (
            part.description
          )
        }
      >
        <p>{part.description}</p>
        {part.command ? <pre>{part.command}</pre> : null}
      </ResolvedActionRow>
    );
  }

  const footer = showResult ? (
    // Submission in flight (status still pending): the in-progress line stays
    // in the card until the request actually resolves.
    <p className="agent-approval-result" data-choice={activeChoice}>
      {activeChoice === "deny" ? <IconCrossMedium size={14} /> : <IconCheckmark2Small size={14} />}
      {approvalChoiceLabel(activeChoice, submitting !== undefined)}
    </p>
  ) : (
    // Compact footer: a split "Approve" (approves once, caret opens the scope
    // menu) and a quiet "Deny" anchor the row; "Explain first" demotes to a
    // plain text-level button pushed to the right edge.
    <div className="agent-approval-actions">
      <ApproveSplitButton
        disabled={disabled}
        allowPermanent={part.allowPermanent}
        onChoice={(choice) => onApproval(part, choice)}
      />
      <button
        type="button"
        className="btn btn-ghost agent-approval-deny"
        disabled={disabled}
        onClick={() => onApproval(part, "deny")}
      >
        Deny
      </button>
      <button
        type="button"
        className="btn btn-ghost agent-approval-explain"
        aria-expanded={explainOpen}
        // Only advertise the panel while it's actually in the DOM (the body
        // renders only when the card is expanded and the explanation is open).
        aria-controls={explainOpen ? explanationId : undefined}
        disabled={disabled}
        onClick={toggleExplain}
      >
        <IconLightBulbSimple size={14} aria-hidden />
        {explainOpen ? "Hide explanation" : "Explain first"}
      </button>
    </div>
  );

  return (
    <CollapsibleActionCard
      title="Approval required"
      description={part.description}
      command={part.command ? <pre>{part.command}</pre> : null}
      // The command is always shown; the only expandable body is the optional
      // explanation, which its own "Explain first" button toggles.
      hasDetails={false}
      expanded={expanded}
      onToggleExpanded={() => {
        const next = !expanded;
        setExpanded(next);
        if (!next) setExplainOpen(false);
      }}
      footer={footer}
    >
      {explainOpen ? (
        <div className="agent-approval-explanation" id={explanationId}>
          {explainState === "loading" ? (
            <p className="agent-approval-explanation-loading" role="status" aria-live="polite">
              <Spinner aria-hidden />
              <span>Working out what this request does…</span>
            </p>
          ) : explainState === "ready" && explanation ? (
            explanation
              .split(/\n{2,}/)
              .map((paragraph) => paragraph.trim())
              .filter(Boolean)
              .map((paragraph, index) => <p key={index}>{paragraph}</p>)
          ) : (
            // Generation unavailable (offline, signed out): keep the
            // static framing rather than an empty panel.
            <p>
              June is paused because this request needs your explicit permission before it can
              continue.
            </p>
          )}
          <p>
            Approve once allows only this request. This session allows matching requests until the
            session ends.{" "}
            {part.allowPermanent ? "Always allows matching requests in future sessions. " : null}
            Deny blocks the request.
          </p>
        </div>
      ) : null}
    </CollapsibleActionCard>
  );
}

function approvalChoiceLabel(choice?: AgentApprovalChoice, pending = false) {
  if (choice === "once") return pending ? "Approving once" : "Approved once";
  if (choice === "session")
    return pending ? "Approving for this session" : "Approved for this session";
  if (choice === "always") return pending ? "Approving permanently" : "Always approved";
  if (choice === "deny") return pending ? "Denying" : "Denied";
  return "Resolved";
}
