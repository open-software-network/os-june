import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMcpServersSection } from "../components/settings/AgentMcpServersSection";
import type { AgentMcpServerDto } from "../lib/agent-mcp";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
}));

vi.mock("../lib/agent-mcp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/agent-mcp")>()),
  listAgentMcpServers: mocks.list,
  createAgentMcpServer: mocks.create,
  updateAgentMcpServer: mocks.update,
  deleteAgentMcpServer: mocks.remove,
  testAgentMcpServer: mocks.test,
}));

const server: AgentMcpServerDto = {
  id: "mcp-tasks",
  name: "Tasks",
  enabled: true,
  transport: "stdio",
  command: "node",
  args: ["server.js"],
  metadata: {},
  toolVisibility: { include: [], exclude: [] },
  safety: {
    requiresApproval: false,
    allowSandboxed: true,
    timeoutMs: 30_000,
    maxOutputBytes: 1_048_576,
    approvalTools: [],
  },
};

describe("AgentMcpServersSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([server]);
    mocks.update.mockImplementation(async (input) => input);
    mocks.remove.mockResolvedValue(undefined);
    mocks.test.mockResolvedValue([{ name: "list_tasks", description: "", inputSchema: {} }]);
  });

  it("hydrates, tests, toggles, and removes persisted servers", async () => {
    const user = userEvent.setup();
    render(<AgentMcpServersSection />);

    expect(await screen.findByText("Tasks")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Test Tasks" }));
    expect(await screen.findByText(/1 tool available/)).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Tasks enabled" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: "mcp-tasks", enabled: false }),
      ),
    );

    await user.click(screen.getByRole("button", { name: "Delete Tasks" }));
    await user.click(screen.getByRole("button", { name: "Delete server" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("mcp-tasks"));
    expect(screen.queryByText("Tasks")).not.toBeInTheDocument();
  });

  it("sends secrets only through the secure create input", async () => {
    mocks.list.mockResolvedValue([]);
    mocks.create.mockImplementation(async (input) => ({
      ...server,
      ...input,
      id: "created",
    }));
    const user = userEvent.setup();
    render(<AgentMcpServersSection />);

    await screen.findByText("No custom servers");
    await user.click(screen.getByRole("button", { name: "Add server" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Private tools");
    await user.type(within(dialog).getByLabelText("Command"), "node");
    fireEvent.change(within(dialog).getByLabelText("Environment variables (JSON)"), {
      target: { value: '{"TOKEN":"secret"}' },
    });
    await user.click(within(dialog).getByRole("button", { name: "Add server" }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Private tools",
          command: "node",
          secrets: { env: { TOKEN: "secret" }, headers: {} },
        }),
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("edits tool visibility without replacing existing keychain credentials", async () => {
    const user = userEvent.setup();
    render(<AgentMcpServersSection />);

    await screen.findByText("Tasks");
    await user.click(screen.getByRole("button", { name: "Configure Tasks" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Allowed tools, one per line"), "list_tasks");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "mcp-tasks",
          toolVisibility: { include: ["list_tasks"], exclude: [] },
        }),
      ),
    );
    expect(mocks.update.mock.calls[0]?.[0]).not.toHaveProperty("secrets");
  });
});
