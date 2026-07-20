import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  connectorApprovalsPending: vi.fn(),
  connectorApprovalRespond: vi.fn(),
  connectorApprovalsRespondAll: vi.fn(),
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  connectorApprovalsPending: tauriMocks.connectorApprovalsPending,
  connectorApprovalRespond: tauriMocks.connectorApprovalRespond,
  connectorApprovalsRespondAll: tauriMocks.connectorApprovalsRespondAll,
}));

// Keep the dynamic `@tauri-apps/api/event` import inert in jsdom.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// Stand in for the real brand-mark SVGs with a provider-tagged marker so a
// test can assert which provider mark rendered without depending on the
// central-icons SVG internals.
vi.mock("../components/connectors/ConnectorProviderIcon", () => ({
  ConnectorProviderIcon: ({ provider }: { provider: string }) => (
    <span data-testid={`provider-icon-${provider}`} />
  ),
}));

import { ConnectorApprovalsTray } from "../components/connectors/ConnectorApprovalsTray";

function approval(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: "a1",
    tool: "send_email",
    server: "june_gmail_actions",
    accountEmail: "jo@example.com",
    summary: "Send reply to Dana",
    argsPreview: "Subject: Re: lunch",
    requestedAtMs: 1,
    ...overrides,
  };
}

beforeEach(() => {
  tauriMocks.connectorApprovalsPending.mockResolvedValue([]);
  tauriMocks.connectorApprovalRespond.mockResolvedValue(undefined);
  tauriMocks.connectorApprovalsRespondAll.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConnectorApprovalsTray", () => {
  it("renders nothing when there is nothing pending", async () => {
    render(<ConnectorApprovalsTray />);
    await waitFor(() => expect(tauriMocks.connectorApprovalsPending).toHaveBeenCalled());
    expect(screen.queryByLabelText("Connector approvals")).toBeNull();
  });

  it("lists a pending approval with its account and a human tool label", async () => {
    tauriMocks.connectorApprovalsPending.mockResolvedValue([approval()]);
    render(<ConnectorApprovalsTray />);
    expect(await screen.findByText("Send reply to Dana")).toBeInTheDocument();
    expect(screen.getByText(/Send email/)).toBeInTheDocument();
    expect(screen.getByText(/jo@example.com/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approvals needed/ })).toBeInTheDocument();
  });

  it("renders a parked Linear action with its label and provider mark", async () => {
    tauriMocks.connectorApprovalsPending.mockResolvedValue([
      approval({
        approvalId: "l1",
        tool: "create_issue",
        server: "june_linear_actions",
        accountEmail: "acme.linear.app",
        summary: "Create issue in ENG",
        argsPreview: "Title: Fix onboarding redirect",
      }),
    ]);
    render(<ConnectorApprovalsTray />);
    expect(await screen.findByText("Create issue in ENG")).toBeInTheDocument();
    expect(screen.getByText(/Create issues/)).toBeInTheDocument();
    expect(screen.getByText(/acme\.linear\.app/)).toBeInTheDocument();
    // One mark in the header's provider stack, one on the row itself.
    expect(screen.getAllByTestId("provider-icon-linear").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("provider-icon-google")).toBeNull();
  });

  it("collapses to a header line with the count and re-expands", async () => {
    tauriMocks.connectorApprovalsPending.mockResolvedValue([
      approval(),
      approval({ approvalId: "a2", summary: "Draft to Sam" }),
    ]);
    render(<ConnectorApprovalsTray />);
    await screen.findByText("Send reply to Dana");

    // Expanded: the list carries the count, so the header shows no pill.
    const trigger = screen.getByRole("button", { name: /Approvals needed/ });
    expect(trigger.querySelector(".status-pill")).toBeNull();

    await userEvent.click(trigger);
    // Collapsed: items and bulk actions fold away; the count pill appears.
    expect(screen.queryByText("Send reply to Dana")).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny all" })).toBeNull();
    expect(trigger.querySelector(".status-pill")).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: "Expand approvals" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Expand approvals" }));
    expect(await screen.findByText("Send reply to Dana")).toBeInTheDocument();
  });

  it("expands a row to the full request detail on click", async () => {
    tauriMocks.connectorApprovalsPending.mockResolvedValue([approval()]);
    render(<ConnectorApprovalsTray />);
    await screen.findByText("Send reply to Dana");

    const info = screen.getByRole("button", { name: /^Send reply to Dana/ });
    expect(info).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(info);
    expect(info).toHaveAttribute("aria-expanded", "true");
    expect(info.closest("li")).toHaveAttribute("data-expanded");
    await userEvent.click(info);
    expect(info).toHaveAttribute("aria-expanded", "false");
  });

  it("approves a single item and refreshes", async () => {
    tauriMocks.connectorApprovalsPending.mockResolvedValueOnce([approval()]).mockResolvedValue([]);
    render(<ConnectorApprovalsTray />);
    await screen.findByText("Send reply to Dana");
    await userEvent.click(screen.getByRole("button", { name: "Approve Send reply to Dana" }));
    expect(tauriMocks.connectorApprovalRespond).toHaveBeenCalledWith({
      approvalId: "a1",
      approve: true,
    });
    await waitFor(() => expect(screen.queryByLabelText("Connector approvals")).toBeNull());
  });

  it("shows bulk controls for multiple items and denies all", async () => {
    tauriMocks.connectorApprovalsPending
      .mockResolvedValueOnce([approval(), approval({ approvalId: "a2", summary: "Draft to Sam" })])
      .mockResolvedValue([]);
    render(<ConnectorApprovalsTray />);
    await screen.findByText("Send reply to Dana");
    await userEvent.click(screen.getByRole("button", { name: "Deny all" }));
    // Only the ids actually rendered are answered, so a later-enqueued action
    // can't be swept into the bulk response.
    expect(tauriMocks.connectorApprovalsRespondAll).toHaveBeenCalledWith({
      approve: false,
      approvalIds: ["a1", "a2"],
    });
  });
});
