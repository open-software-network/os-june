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
    expect(screen.getByText("Approvals needed (1)")).toBeInTheDocument();
  });

  it("approves a single item and refreshes", async () => {
    tauriMocks.connectorApprovalsPending.mockResolvedValueOnce([approval()]).mockResolvedValue([]);
    render(<ConnectorApprovalsTray />);
    await screen.findByText("Send reply to Dana");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
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
    expect(screen.getByText("Approvals needed (2)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Deny all" }));
    expect(tauriMocks.connectorApprovalsRespondAll).toHaveBeenCalledWith({ approve: false });
  });
});
