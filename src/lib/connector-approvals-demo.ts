// Dev-only console driver for the connector approvals tray.
//
//   __connectorApprovals()        this help
//   __connectorApprovals(3)       park N sample approvals (default 3)
//   __connectorApprovals("one")   a single approval (no bulk row)
//   __connectorApprovals("long")  eight approvals to exercise the scroll fade
//   __connectorApprovals("clear") dismiss the tray
//
// The tray owns its pending list as React state fed by the Rust proxy, so the
// driver pushes synthetic approvals straight into that state. Approve/Deny
// still call the real Tauri commands, which fail harmlessly outside the app —
// use "clear" to dismiss. Never bundled in production: the tray gates the
// dynamic import on import.meta.env.DEV.

import type { PendingConnectorApproval } from "./tauri";

export type ConnectorApprovalsDemoApi = {
  /** Remove the window hook. */
  dispose: () => void;
};

const HELP = [
  "Connector approvals tray demo:",
  "  __connectorApprovals(3)       park N sample approvals (default 3)",
  '  __connectorApprovals("one")   a single approval (no bulk row)',
  '  __connectorApprovals("long")  eight approvals (scroll fade)',
  '  __connectorApprovals("clear") dismiss the tray',
  "",
  'Approve/Deny hit the real bridge and fail outside the app; use "clear".',
].join("\n");

const SAMPLES: Array<Omit<PendingConnectorApproval, "approvalId" | "requestedAtMs">> = [
  {
    tool: "create_draft",
    server: "june_gmail_actions",
    accountEmail: "alex@example.com",
    summary: "Draft a reply to Priya about the Q3 launch timeline",
    argsPreview:
      "To: priya@lumon.dev\nSubject: Re: Q3 launch timeline\nHappy to move the review to Thursday if that unblocks the…",
  },
  {
    tool: "create_event",
    server: "june_gcal_actions",
    accountEmail: "alex@example.com",
    summary: "Block 45 minutes of prep before the design review",
    argsPreview: "Thu 11:15 to 12:00 · Design review prep",
  },
  {
    tool: "create_draft",
    server: "june_gmail_actions",
    accountEmail: "alex@example.com",
    summary: "Draft a project update for the product team",
    argsPreview: "To: product@example.com\nSubject: Project update",
  },
  {
    tool: "send_email",
    server: "june_gmail_actions",
    accountEmail: "alex@example.com",
    summary: "Send the weekly briefing to the team list",
    argsPreview: "To: team@lumon.dev\nSubject: Week 28 briefing",
  },
  {
    tool: "archive",
    server: "june_gmail_actions",
    accountEmail: "alex@example.com",
    summary: "Archive 12 resolved support threads",
    argsPreview: "",
  },
  {
    tool: "create_event",
    server: "june_gcal_actions",
    accountEmail: "alex@example.com",
    summary: "Schedule a follow-up after the platform sync",
    argsPreview: "Fri 14:00 to 14:30 · Platform sync follow-up",
  },
  {
    tool: "respond_to_invite",
    server: "june_gcal_actions",
    accountEmail: "alex@example.com",
    summary: "Accept the vendor intro on Friday",
    argsPreview: "",
  },
  {
    tool: "modify_labels",
    server: "june_gmail_actions",
    accountEmail: "alex@example.com",
    summary: "Label 4 newsletters as Reading",
    argsPreview: "",
  },
];

export function registerConnectorApprovalsDemo({
  setPending,
}: {
  setPending: (items: PendingConnectorApproval[]) => void;
}): ConnectorApprovalsDemoApi {
  const win = window as unknown as Record<string, unknown>;

  function park(count: number) {
    const now = Date.now();
    const parked = Math.max(1, Math.min(count, SAMPLES.length));
    // Only Google ships today, so the real header stack never shows more than
    // one mark. Preview the overlapping-logo treatment by asking the tray to
    // repeat the mark up to 3 times (it honors this only in DEV).
    win.__connectorApprovalsStack = Math.min(parked, 3);
    setPending(
      Array.from({ length: parked }, (_, index) => ({
        ...SAMPLES[index % SAMPLES.length],
        approvalId: `demo-${index}`,
        requestedAtMs: now - index * 45_000,
      })),
    );
  }

  const hook = (state?: string | number) => {
    if (typeof state === "number") {
      park(state);
      return `${state} approvals parked. __connectorApprovals("clear") to dismiss.`;
    }
    switch (state) {
      case "show":
        park(3);
        return 'Approvals parked. __connectorApprovals("clear") to dismiss.';
      case "one":
        park(1);
        return 'Single approval parked. __connectorApprovals("clear") to dismiss.';
      case "long":
        park(8);
        return 'Eight approvals parked. __connectorApprovals("clear") to dismiss.';
      case "clear":
      case "stop":
        setPending([]);
        return "Approvals tray dismissed.";
      default:
        return HELP;
    }
  };

  (window as unknown as Record<string, unknown>).__connectorApprovals = hook;

  function dispose() {
    delete (window as unknown as Record<string, unknown>).__connectorApprovals;
  }

  return { dispose };
}
