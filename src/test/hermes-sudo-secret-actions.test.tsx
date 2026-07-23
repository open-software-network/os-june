import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AgentCliAccessCard,
  ApprovalPart,
  ClarifyPart,
  SudoPart,
  SecretPart,
  turnIsConcreteResponse,
} from "../components/agent/AgentWorkspace";
import {
  AgentChatTurnRow,
  type AgentChatTurnRowProps,
} from "../components/agent/chat-turns/AgentChatTurnRow";
import type { AgentChatPart, AgentChatTurn } from "../lib/agent-chat-runtime";
import { createHermesMethods } from "../lib/hermes-control-plane";
import secretFixture from "../lib/hermes-control-plane/fixtures/secret-request-response.json";

const SECRET_VALUE = secretFixture._secretValuePlaceholder;

function sudoPart(
  overrides: Partial<Extract<AgentChatPart, { type: "sudo" }>> = {},
): Extract<AgentChatPart, { type: "sudo" }> {
  return {
    type: "sudo",
    id: "su-1",
    sessionId: "sess-sudo",
    command: "apt-get install ripgrep",
    reason: "ripgrep is required to search the dependency tree",
    mode: "unrestricted",
    status: "pending",
    ...overrides,
  };
}

function secretPart(
  overrides: Partial<Extract<AgentChatPart, { type: "secret" }>> = {},
): Extract<AgentChatPart, { type: "secret" }> {
  return {
    type: "secret",
    id: "se-1",
    sessionId: "sess-secret",
    keyName: "OPENAI_API_KEY",
    reason: "Needed to call the OpenAI API on your behalf",
    status: "pending",
    ...overrides,
  };
}

describe("SudoPart card", () => {
  it("blocks the session with an explicit approve/deny card showing the reason and mode", async () => {
    render(<SudoPart part={sudoPart()} onSudo={() => {}} />);

    // The prose reason and the exact command both show by default — SECURITY:
    // the command must be visible at the decision point, since Approve is live
    // while the card is collapsed.
    expect(
      screen.getByText(/ripgrep is required to search the dependency tree/),
    ).toBeInTheDocument();
    expect(screen.getByText("apt-get install ripgrep")).toBeInTheDocument();
    // The unrestricted mode badge stays visible while collapsed so the blast
    // radius reads before expanding.
    expect(document.querySelector(".agent-sudo-mode-badge")?.textContent).toMatch(/unrestricted/i);
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();

    // Details reveals only the fuller execution-mode notice (the command is
    // already shown above).
    expect(document.querySelector(".agent-sudo-mode-notice")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(document.querySelector(".agent-sudo-mode-notice")?.textContent).toMatch(/unrestricted/i);
  });

  it("invokes respondToSudo with approved=true and the mode when approved", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const methods = createHermesMethods(request);
    const onSudo = vi.fn((part: Extract<AgentChatPart, { type: "sudo" }>) =>
      methods.respondToSudo({
        sessionId: part.sessionId ?? "",
        requestId: part.id,
        approved: true,
        mode: part.mode,
      }),
    );

    render(<SudoPart part={sudoPart()} onSudo={onSudo} />);
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    expect(onSudo).toHaveBeenCalledWith(expect.objectContaining({ id: "su-1" }), true);
    expect(request).toHaveBeenCalledWith("sudo.respond", {
      session_id: "sess-sudo",
      request_id: "su-1",
      approved: true,
      mode: "unrestricted",
    });
  });

  it("invokes respondToSudo with approved=false when denied", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const methods = createHermesMethods(request);
    const onSudo = vi.fn((part: Extract<AgentChatPart, { type: "sudo" }>) =>
      methods.respondToSudo({
        sessionId: part.sessionId ?? "",
        requestId: part.id,
        approved: false,
      }),
    );

    render(<SudoPart part={sudoPart()} onSudo={onSudo} />);
    await userEvent.click(screen.getByRole("button", { name: /deny/i }));

    expect(onSudo).toHaveBeenCalledWith(expect.objectContaining({ id: "su-1" }), false);
    expect(request).toHaveBeenCalledWith("sudo.respond", {
      session_id: "sess-sudo",
      request_id: "su-1",
      approved: false,
    });
  });

  it("degrades to an actionable card when command and reason are absent", () => {
    render(
      <SudoPart
        part={sudoPart({
          command: undefined,
          reason: undefined,
          mode: undefined,
        })}
        onSudo={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
  });
});

describe("SecretPart card", () => {
  it("blocks the session with a secure input and explains where the secret is used", () => {
    render(<SecretPart part={secretPart()} onSecret={() => {}} />);

    // The reason explains where the secret is used.
    expect(screen.getByText(/Needed to call the OpenAI API on your behalf/)).toBeInTheDocument();
    // OPENAI_API_KEY matches the sensitive-key pattern, so the label is masked
    // rather than shown verbatim (see the dedicated redaction test).
    expect(screen.queryByText("OPENAI_API_KEY")).not.toBeInTheDocument();
    const input = screen.getByLabelText(/secret value/i) as HTMLInputElement;
    // A secure input never echoes the typed value to the screen.
    expect(input.type).toBe("password");
  });

  it("submits the typed value through respondToSecret then clears it from local state", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const methods = createHermesMethods(request);
    const onSecret = vi.fn((part: Extract<AgentChatPart, { type: "secret" }>, value: string) =>
      methods.respondToSecret({
        sessionId: part.sessionId ?? "",
        requestId: part.id,
        value,
      }),
    );

    render(<SecretPart part={secretPart()} onSecret={onSecret} />);
    const input = screen.getByLabelText(/secret value/i) as HTMLInputElement;
    await userEvent.type(input, SECRET_VALUE);
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(onSecret).toHaveBeenCalledWith(expect.objectContaining({ id: "se-1" }), SECRET_VALUE);
    expect(request).toHaveBeenCalledWith("secret.respond", {
      session_id: "sess-secret",
      request_id: "se-1",
      value: SECRET_VALUE,
    });

    // SECURITY: the input is cleared immediately after submit so the value
    // does not linger in the DOM/local state.
    await waitFor(() => {
      expect((screen.getByLabelText(/secret value/i) as HTMLInputElement).value).toBe("");
    });
  });

  it("SECURITY: never shows the typed value and wipes it from the DOM on submit", async () => {
    const onSecret = vi.fn();
    render(<SecretPart part={secretPart()} onSecret={onSecret} />);
    const input = screen.getByLabelText(/secret value/i) as HTMLInputElement;
    await userEvent.type(input, SECRET_VALUE);

    // While typing the value lives only on the masked password input — never in
    // any VISIBLE rendered text.
    expect(document.body.textContent ?? "").not.toContain(SECRET_VALUE);

    // After submit the value is handed off once and then wiped from local state,
    // so it no longer exists anywhere in the DOM (value property or serialized
    // attribute).
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));
    await waitFor(() => {
      const cleared = screen.getByLabelText(/secret value/i) as HTMLInputElement;
      expect(cleared.value).toBe("");
    });
    expect(document.body.innerHTML).not.toContain(SECRET_VALUE);
    expect(document.body.textContent ?? "").not.toContain(SECRET_VALUE);
    // The value reached the handler exactly once, by value, and is not retained.
    expect(onSecret).toHaveBeenCalledTimes(1);
    expect(onSecret).toHaveBeenCalledWith(expect.anything(), SECRET_VALUE);
  });

  it("supports cancel without submitting any value", async () => {
    const onSecret = vi.fn();
    const onCancel = vi.fn();
    render(<SecretPart part={secretPart()} onSecret={onSecret} onCancel={onCancel} />);
    const input = screen.getByLabelText(/secret value/i) as HTMLInputElement;
    await userEvent.type(input, SECRET_VALUE);
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onSecret).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: "se-1" }));
    // Cancel also wipes the entered value.
    await waitFor(() => {
      expect((screen.getByLabelText(/secret value/i) as HTMLInputElement).value).toBe("");
    });
  });

  it("redacts a secret-like key name in the label", () => {
    // A key like "DATABASE_PASSWORD" must be masked, never shown verbatim.
    render(<SecretPart part={secretPart({ keyName: "DATABASE_PASSWORD" })} onSecret={() => {}} />);
    expect(screen.queryByText("DATABASE_PASSWORD")).not.toBeInTheDocument();
    expect(screen.getByText(/\[redacted\]/i)).toBeInTheDocument();
  });
});

function approvalPart(
  overrides: Partial<Extract<AgentChatPart, { type: "approval" }>> = {},
): Extract<AgentChatPart, { type: "approval" }> {
  return {
    type: "approval",
    id: "ap-1",
    sessionId: "sess-approval",
    command: "rm -rf ./build && npm run build",
    description: "The agent wants to run a shell command.",
    allowPermanent: true,
    status: "pending",
    ...overrides,
  };
}

function clarifyPart(
  overrides: Partial<Extract<AgentChatPart, { type: "clarify" }>> = {},
): Extract<AgentChatPart, { type: "clarify" }> {
  return {
    type: "clarify",
    id: "cl-1",
    sessionId: "sess-clarify",
    question: "Which format should the recap use?",
    choices: ["Bulleted list", "Numbered steps"],
    status: "pending",
    ...overrides,
  };
}

/** The collapsed resolved receipt is a <details> row (role "group"). */
function resolvedRow() {
  return document.querySelector(".agent-resolved-row") as HTMLDetailsElement | null;
}

function actionTurnRow(part: AgentChatPart, overrides: Partial<AgentChatTurnRowProps> = {}) {
  return (
    <AgentChatTurnRow
      approvalSubmitting={{}}
      clarifySubmitting={{}}
      sudoSubmitting={{}}
      secretSubmitting={{}}
      thinkingOpen={() => false}
      onApproval={() => {}}
      onClarify={() => {}}
      onSudo={() => {}}
      onSecret={() => {}}
      onThinkingOpenChange={() => {}}
      turn={{
        id: "action-turn",
        role: "assistant",
        createdAt: "2026-07-23T10:00:00Z",
        status: "complete",
        parts: [part],
      }}
      {...overrides}
    />
  );
}

describe("AgentChatTurnRow action-card clearance", () => {
  it.each([
    ["approval", approvalPart(), approvalPart({ status: "resolved", choice: "once" })],
    ["clarification", clarifyPart(), clarifyPart({ status: "resolved", answer: "Bulleted list" })],
    ["sudo", sudoPart(), sudoPart({ status: "resolved", approved: true })],
    ["secret", secretPart(), secretPart({ status: "resolved" })],
  ])("only marks a %s turn while its actionable card is rendered", (_label, pending, resolved) => {
    const { rerender } = render(actionTurnRow(pending));

    expect(document.querySelector(".agent-assistant-turn-body")).toHaveClass(
      "agent-assistant-turn-body-action-card",
    );

    rerender(actionTurnRow(resolved));

    expect(document.querySelector(".agent-resolved-row")).toBeInTheDocument();
    expect(document.querySelector(".agent-assistant-turn-body")).not.toHaveClass(
      "agent-assistant-turn-body-action-card",
    );
  });

  it("drops the Agent CLI marker when the access card is dismissed", async () => {
    render(
      actionTurnRow(
        { type: "text", text: "[REQUEST:AGENT_CLI_ACCESS]", status: "complete" },
        { cliAccess: { enabled: false, submitting: false, onEnable: () => {} } },
      ),
    );

    expect(document.querySelector(".agent-assistant-turn-body")).toHaveClass(
      "agent-assistant-turn-body-action-card",
    );

    await userEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(document.querySelector(".agent-resolved-row")).toBeInTheDocument();
    expect(document.querySelector(".agent-assistant-turn-body")).not.toHaveClass(
      "agent-assistant-turn-body-action-card",
    );
  });
});

describe("ApprovalPart", () => {
  it("pending renders a compact card with a split Approve, Deny, and a scope menu", async () => {
    render(<ApprovalPart part={approvalPart()} onApproval={() => {}} />);

    expect(resolvedRow()).toBeNull();
    expect(document.querySelector(".agent-approval-card")).toBeInTheDocument();
    // Two anchor actions (Approve / Deny) plus the scope caret and Explain first.
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
    const scope = screen.getByRole("button", { name: /approve options/i });
    // The scope choices live behind the caret — hidden until it opens.
    expect(screen.queryByRole("menuitem", { name: /approve once/i })).not.toBeInTheDocument();

    await userEvent.click(scope);
    expect(screen.getByRole("menuitem", { name: "Approve once" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Approve for this session" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Always approve" })).toBeInTheDocument();
  });

  it("the scope menu fires the matching choice for each item", async () => {
    for (const [name, choice] of [
      ["Approve once", "once"],
      ["Approve for this session", "session"],
      ["Always approve", "always"],
    ] as const) {
      const onApproval = vi.fn();
      const { unmount } = render(<ApprovalPart part={approvalPart()} onApproval={onApproval} />);
      await userEvent.click(screen.getByRole("button", { name: /approve options/i }));
      await userEvent.click(screen.getByRole("menuitem", { name }));
      expect(onApproval).toHaveBeenCalledWith(expect.objectContaining({ id: "ap-1" }), choice);
      unmount();
    }
  });

  it("the top-level Approve approves once, and hides Always approve when not permitted", async () => {
    const onApproval = vi.fn();
    const { unmount } = render(<ApprovalPart part={approvalPart()} onApproval={onApproval} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApproval).toHaveBeenCalledWith(expect.objectContaining({ id: "ap-1" }), "once");
    unmount();

    render(<ApprovalPart part={approvalPart({ allowPermanent: false })} onApproval={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /approve options/i }));
    expect(screen.getByRole("menuitem", { name: "Approve once" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Always approve" })).not.toBeInTheDocument();
  });

  it("moves focus into the scope menu on open and returns it to the caret on Escape", async () => {
    render(<ApprovalPart part={approvalPart()} onApproval={() => {}} />);
    const scope = screen.getByRole("button", { name: /approve options/i });
    await userEvent.click(scope);
    // Focus lands on the first menu item so arrow keys work immediately.
    expect(screen.getByRole("menuitem", { name: "Approve once" })).toHaveFocus();
    // Escape dismisses and returns focus to the caret (not to <body>).
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem", { name: "Approve once" })).not.toBeInTheDocument();
    expect(scope).toHaveFocus();
  });

  it("keeps the expanded card with an in-progress line while a submission is in flight", () => {
    // status still pending, submitting set — the card must not collapse yet.
    render(<ApprovalPart part={approvalPart()} onApproval={() => {}} submitting="once" />);

    expect(resolvedRow()).toBeNull();
    expect(document.querySelector(".agent-approval-card")).toBeInTheDocument();
    expect(screen.getByText("Approving once")).toBeInTheDocument();
  });

  it("resolved collapses to a one-line receipt row (no action buttons) that expands to the detail", async () => {
    render(
      <ApprovalPart
        part={approvalPart({ status: "resolved", choice: "session" })}
        onApproval={() => {}}
      />,
    );

    const row = resolvedRow();
    expect(row).not.toBeNull();
    // Collapsed: the outcome label shows and no buttons render.
    expect(within(row as HTMLElement).getByText("Approved for this session")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve once/i })).not.toBeInTheDocument();
    // The command shows in the collapsed detail and again in the expandable body.
    expect(
      within(row as HTMLElement).getAllByText("rm -rf ./build && npm run build").length,
    ).toBeGreaterThan(0);

    // The row is keyboard-operable via native <details>: opening reveals the body.
    (row as HTMLDetailsElement).open = true;
    expect((row as HTMLDetailsElement).open).toBe(true);
  });

  it("resolved denial tints the row as a denied outcome", () => {
    render(
      <ApprovalPart
        part={approvalPart({ status: "resolved", choice: "deny" })}
        onApproval={() => {}}
      />,
    );
    const row = resolvedRow();
    expect(row?.dataset.choice).toBe("deny");
    expect(within(row as HTMLElement).getByText("Denied")).toBeInTheDocument();
  });
});

describe("ClarifyPart", () => {
  it("pending renders the choice buttons", () => {
    render(<ClarifyPart part={clarifyPart()} onClarify={() => {}} />);
    expect(resolvedRow()).toBeNull();
    expect(screen.getByRole("button", { name: /bulleted list/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /numbered steps/i })).toBeInTheDocument();
  });

  it("resolved+answered collapses to an 'Answered' receipt showing the answer on expand", () => {
    render(
      <ClarifyPart
        part={clarifyPart({ status: "resolved", answer: "Bulleted list" })}
        onClarify={() => {}}
      />,
    );
    const row = resolvedRow();
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("Answered")).toBeInTheDocument();
    // The question and answer live in the expandable body; no buttons.
    expect(within(row as HTMLElement).getByText("Bulleted list")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /bulleted list/i })).not.toBeInTheDocument();
  });

  it("resolved+skipped collapses to a 'Skipped' receipt", () => {
    render(
      <ClarifyPart part={clarifyPart({ status: "resolved", answer: "" })} onClarify={() => {}} />,
    );
    const row = resolvedRow();
    expect(within(row as HTMLElement).getByText("Skipped")).toBeInTheDocument();
  });
});

describe("SudoPart resolved", () => {
  it("collapses to a one-line receipt row that expands to the command and mode", () => {
    render(<SudoPart part={sudoPart({ status: "resolved", approved: true })} onSudo={() => {}} />);
    const row = resolvedRow();
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("Approved")).toBeInTheDocument();
    // No action buttons on a resolved receipt.
    expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
    // Command and mode line live in the expandable body.
    expect(
      within(row as HTMLElement).getAllByText("apt-get install ripgrep").length,
    ).toBeGreaterThan(0);
    expect(within(row as HTMLElement).getByText(/unrestricted/i)).toBeInTheDocument();
  });
});

describe("SecretPart resolved", () => {
  it("collapses to a 'Secret provided' receipt and never shows the input", () => {
    render(
      <SecretPart
        part={secretPart({ status: "resolved", keyName: "GITHUB_USERNAME" })}
        onSecret={() => {}}
      />,
    );
    const row = resolvedRow();
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("Secret provided")).toBeInTheDocument();
    // No secure input on the receipt.
    expect(screen.queryByLabelText(/secret value/i)).not.toBeInTheDocument();
    // Benign key names surface (in the collapsed detail and expanded body).
    expect(within(row as HTMLElement).getAllByText("GITHUB_USERNAME").length).toBeGreaterThan(0);
  });
});

describe("AgentCliAccessCard", () => {
  it("pending renders the enable/not-now choice", () => {
    render(
      <AgentCliAccessCard cliAccess={{ enabled: false, submitting: false, onEnable: () => {} }} />,
    );
    expect(resolvedRow()).toBeNull();
    expect(screen.getByRole("button", { name: /enable agent cli access/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /not now/i })).toBeInTheDocument();
  });

  it("enabled collapses to an 'Agent CLI access enabled' receipt", () => {
    render(
      <AgentCliAccessCard cliAccess={{ enabled: true, submitting: false, onEnable: () => {} }} />,
    );
    const row = resolvedRow();
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("Agent CLI access enabled")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /enable agent cli access/i }),
    ).not.toBeInTheDocument();
  });
});

describe("action card refinements", () => {
  it("pending cards carry no title glyph (title text stands alone)", () => {
    const { unmount: u1 } = render(<ApprovalPart part={approvalPart()} onApproval={() => {}} />);
    expect(document.querySelector(".agent-approval-card .agent-tool-title .agent-tool-icon")).toBe(
      null,
    );
    u1();

    const { unmount: u2 } = render(<SudoPart part={sudoPart()} onSudo={() => {}} />);
    expect(document.querySelector(".agent-approval-card .agent-tool-title .agent-tool-icon")).toBe(
      null,
    );
    u2();

    const { unmount: u3 } = render(<SecretPart part={secretPart()} onSecret={() => {}} />);
    expect(document.querySelector(".agent-approval-card .agent-tool-title .agent-tool-icon")).toBe(
      null,
    );
    u3();

    render(<ClarifyPart part={clarifyPart()} onClarify={() => {}} />);
    expect(document.querySelector(".agent-clarify-card .agent-tool-title .agent-tool-icon")).toBe(
      null,
    );
  });

  it("the pending approval card shows the description and the command together", () => {
    render(<ApprovalPart part={approvalPart()} onApproval={() => {}} />);
    // The header is a plain row now, not a toggle button.
    expect(screen.queryByRole("button", { name: /approval required/i })).toBeNull();
    // SECURITY: the description AND the exact command are both visible by
    // default — Approve is live while collapsed, so the user must see what they
    // are authorizing without expanding anything. No Details disclosure to hide
    // it behind.
    expect(screen.getByText("The agent wants to run a shell command.")).toBeInTheDocument();
    expect(document.querySelector(".agent-approval-card pre")?.textContent).toBe(
      "rm -rf ./build && npm run build",
    );
    expect(screen.queryByRole("button", { name: /details/i })).toBeNull();
  });

  it("shows the description alone when an approval has no command", () => {
    render(<ApprovalPart part={approvalPart({ command: undefined })} onApproval={() => {}} />);
    // No command to show; the description still reads and there is no Details.
    expect(document.querySelector(".agent-approval-card pre")).toBeNull();
    expect(screen.queryByRole("button", { name: /details/i })).toBeNull();
    expect(screen.getByText("The agent wants to run a shell command.")).toBeInTheDocument();
  });

  it("renders Explain first as a system ghost button", () => {
    render(<ApprovalPart part={approvalPart()} onApproval={() => {}} />);
    const explain = screen.getByRole("button", { name: "Explain first" });
    expect(explain.classList.contains("btn")).toBe(true);
    expect(explain.classList.contains("btn-ghost")).toBe(true);
    // A leading lightbulb glyph precedes the label (aria-hidden, so the
    // accessible name stays "Explain first").
    expect(explain.querySelector("svg")).not.toBeNull();
  });

  it("the resolved receipt reuses the tool-disclosure row treatment", () => {
    render(
      <ApprovalPart
        part={approvalPart({ status: "resolved", choice: "once" })}
        onApproval={() => {}}
      />,
    );
    const row = resolvedRow();
    // Same class the tool rows use, so the receipt is sized identically.
    expect(row?.classList.contains("agent-tool-disclosure")).toBe(true);
  });

  it("the resolved receipt body does not restate the outcome", () => {
    render(
      <ApprovalPart
        part={approvalPart({ status: "resolved", choice: "session" })}
        onApproval={() => {}}
      />,
    );
    const row = resolvedRow();
    // No .agent-approval-result-style outcome line inside the receipt body — the
    // summary already carries the outcome label.
    expect(row?.querySelector(".agent-approval-result")).toBe(null);
    expect(within(row as HTMLElement).queryByText("Approved once")).not.toBeInTheDocument();
  });

  it("surfaces the sudo execution mode on the COLLAPSED card, before the full notice is expanded", () => {
    // Blast radius must read at the decision point: the collapsed unrestricted
    // card carries a warning badge even though the full InlineNotice lives in the
    // body.
    const { unmount } = render(
      <SudoPart part={sudoPart({ mode: "unrestricted" })} onSudo={() => {}} />,
    );
    // The header is a plain row; the Details disclosure owns the collapsed state.
    expect(screen.queryByRole("button", { name: /privilege escalation requested/i })).toBeNull();
    expect(screen.getByRole("button", { name: /details/i }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    // No expanded body yet, so the full InlineNotice is absent...
    expect(document.querySelector(".agent-sudo-mode-notice")).toBeNull();
    // ...but the unrestricted badge is visible in the collapsed header and the
    // Approve button is already live.
    const badge = document.querySelector(".agent-sudo-mode-badge");
    expect(badge?.textContent).toMatch(/unrestricted/i);
    // A leading warning glyph precedes the label so the badge reads as negative.
    expect(badge?.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: /^approve$/i })).toBeEnabled();
    unmount();

    // Sandboxed is the safe default: no collapsed badge (the full mode line still
    // appears in Details).
    render(<SudoPart part={sudoPart({ mode: "sandboxed" })} onSudo={() => {}} />);
    expect(document.querySelector(".agent-sudo-mode-badge")).toBeNull();
  });

  it("pending sudo shows the execution mode as a tone-aware InlineNotice in the expanded body", async () => {
    const { unmount } = render(
      <SudoPart part={sudoPart({ mode: "unrestricted" })} onSudo={() => {}} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /details/i }));
    const warnNotice = document.querySelector(".agent-sudo-mode-notice");
    expect(warnNotice?.getAttribute("data-tone")).toBe("warning");
    expect(warnNotice?.textContent).toMatch(/unrestricted/i);
    unmount();

    render(<SudoPart part={sudoPart({ mode: "sandboxed" })} onSudo={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /details/i }));
    const infoNotice = document.querySelector(".agent-sudo-mode-notice");
    expect(infoNotice?.getAttribute("data-tone")).toBe("info");
    expect(infoNotice?.textContent).toMatch(/sandboxed/i);
  });

  it("the resolved sudo receipt shows the mode as plain text (no notice chrome)", () => {
    render(<SudoPart part={sudoPart({ status: "resolved", approved: true })} onSudo={() => {}} />);
    const row = resolvedRow();
    // Receipts stay quiet: plain text mode line, never an InlineNotice.
    expect(row?.querySelector(".agent-sudo-mode-notice")).toBe(null);
    expect(row?.querySelector(".agent-sudo-mode-receipt")).not.toBeNull();
  });
});

describe("turnIsConcreteResponse", () => {
  const assistant = (parts: AgentChatPart[]): Pick<AgentChatTurn, "role" | "parts"> => ({
    role: "assistant",
    parts,
  });

  it("is true for a user message (always concrete) and an assistant text answer", () => {
    expect(
      turnIsConcreteResponse({
        role: "user",
        parts: [{ type: "text", text: "hi", status: "complete" }],
      }),
    ).toBe(true);
    expect(
      turnIsConcreteResponse(
        assistant([{ type: "text", text: "Here you go.", status: "complete" }]),
      ),
    ).toBe(true);
  });

  it("is true for a finished image but not one still generating", () => {
    expect(
      turnIsConcreteResponse(
        assistant([{ type: "image", status: "complete", prompt: "a fox" } as AgentChatPart]),
      ),
    ).toBe(true);
    expect(
      turnIsConcreteResponse(
        assistant([{ type: "image", status: "running", prompt: "a fox" } as AgentChatPart]),
      ),
    ).toBe(false);
  });

  it("is false for process and interaction turns (thinking, tools, cards, empty)", () => {
    // The screenshot case: a running tool row gets no timestamp below it.
    expect(
      turnIsConcreteResponse(
        assistant([{ type: "tool", id: "t", name: "Read File", text: "", status: "running" }]),
      ),
    ).toBe(false);
    expect(
      turnIsConcreteResponse(
        assistant([{ type: "reasoning", text: "thinking...", status: "running" }]),
      ),
    ).toBe(false);
    for (const type of ["approval", "clarify", "sudo", "secret"] as const) {
      expect(turnIsConcreteResponse(assistant([{ type, id: type } as AgentChatPart]))).toBe(false);
    }
    expect(turnIsConcreteResponse(assistant([]))).toBe(false);
    // Whitespace-only text is not a concrete answer.
    expect(
      turnIsConcreteResponse(assistant([{ type: "text", text: "   ", status: "complete" }])),
    ).toBe(false);
  });

  it("is true when an assistant turn mixes a tool call with a real text answer", () => {
    expect(
      turnIsConcreteResponse(
        assistant([
          { type: "tool", id: "t", name: "Read File", text: "", status: "complete" },
          { type: "text", text: "Done.", status: "complete" },
        ]),
      ),
    ).toBe(true);
  });
});
