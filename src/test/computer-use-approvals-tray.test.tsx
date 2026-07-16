import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  computerUseApprovalsPending: vi.fn(),
  computerUseCaptureSrc: vi.fn((path: string) => `asset://${path}`),
  computerUseStop: vi.fn(),
  respondComputerUseApproval: vi.fn(),
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  computerUseApprovalsPending: tauriMocks.computerUseApprovalsPending,
  computerUseCaptureSrc: tauriMocks.computerUseCaptureSrc,
  computerUseStop: tauriMocks.computerUseStop,
  respondComputerUseApproval: tauriMocks.respondComputerUseApproval,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { ComputerUseApprovalsTray } from "../components/agent/ComputerUseApprovalsTray";

function approval(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: "approval-1",
    actionId: "action-1",
    action: "click",
    targetApp: "TextEdit",
    summary: "Click Save",
    capturePath: "/tmp/capture.png",
    requestedAtMs: 1,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  tauriMocks.computerUseApprovalsPending.mockResolvedValue([]);
  tauriMocks.computerUseStop.mockResolvedValue({ stopped: true });
  tauriMocks.respondComputerUseApproval.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ComputerUseApprovalsTray", () => {
  it("renders nothing without pending actions", async () => {
    render(<ComputerUseApprovalsTray />);
    await waitFor(() => expect(tauriMocks.computerUseApprovalsPending).toHaveBeenCalled());
    expect(screen.queryByLabelText("Computer use approvals")).toBeNull();
  });

  it("shows target context and only per-action decisions", async () => {
    tauriMocks.computerUseApprovalsPending.mockResolvedValue([approval()]);
    render(<ComputerUseApprovalsTray />);

    expect(await screen.findByText("Click Save")).toBeInTheDocument();
    expect(screen.getByText(/TextEdit/)).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute("src", "asset:///tmp/capture.png");
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeInTheDocument();
    expect(screen.getByText(/Expires at/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve all" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny all" })).toBeNull();
    expect(screen.getByRole("list")).toHaveClass("scroll-fade-mask");
  });

  it("answers exactly one approval", async () => {
    tauriMocks.computerUseApprovalsPending
      .mockResolvedValueOnce([approval()])
      .mockResolvedValue([]);
    render(<ComputerUseApprovalsTray />);

    await userEvent.click(await screen.findByRole("button", { name: "Allow once" }));
    expect(tauriMocks.respondComputerUseApproval).toHaveBeenCalledWith({
      approvalId: "approval-1",
      approve: true,
    });
  });

  it("stops the broker and clears pending work", async () => {
    tauriMocks.computerUseApprovalsPending
      .mockResolvedValueOnce([approval()])
      .mockResolvedValue([]);
    render(<ComputerUseApprovalsTray />);

    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(tauriMocks.computerUseStop).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed decision visible and explains the failure", async () => {
    tauriMocks.computerUseApprovalsPending.mockResolvedValue([approval()]);
    tauriMocks.respondComputerUseApproval.mockRejectedValueOnce(new Error("Approval expired"));
    render(<ComputerUseApprovalsTray />);

    await userEvent.click(await screen.findByRole("button", { name: "Deny" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Approval expired");
    expect(screen.getByText("Click Save")).toBeInTheDocument();
  });
});
