import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconSettingsGear4 } from "central-icons/IconSettingsGear4";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useCallback, useEffect, useState } from "react";
import {
  createAgentMcpServer,
  DEFAULT_AGENT_MCP_SAFETY,
  deleteAgentMcpServer,
  listAgentMcpServers,
  testAgentMcpServer,
  updateAgentMcpServer,
  type AgentMcpServerDto,
  type AgentMcpTransport,
} from "../../lib/agent-mcp";
import { Dialog } from "../ui/Dialog";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { InlineNotice } from "../ui/InlineNotice";
import { Switch } from "../ui/Switch";

type Draft = {
  name: string;
  transport: AgentMcpTransport;
  command: string;
  args: string;
  url: string;
  env: string;
  headers: string;
  includeTools: string;
  excludeTools: string;
  approvalTools: string;
  requiresApproval: boolean;
  allowSandboxed: boolean;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  env: "",
  headers: "",
  includeTools: "",
  excludeTools: "",
  approvalTools: "",
  requiresApproval: true,
  allowSandboxed: true,
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseSecretMap(raw: string, label: string): Record<string, string> {
  if (!raw.trim()) return {};
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.values(value).some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${label} must be a JSON object whose values are strings.`);
  }
  return value as Record<string, string>;
}

export function AgentMcpServersSection() {
  const [servers, setServers] = useState<AgentMcpServerDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<AgentMcpServerDto>();
  const [toDelete, setToDelete] = useState<AgentMcpServerDto>();
  const [saveError, setSaveError] = useState<string>();
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setServers(await listAgentMcpServers());
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(server: AgentMcpServerDto, enabled: boolean) {
    setBusyId(server.id);
    setError(undefined);
    try {
      const updated = await updateAgentMcpServer({
        ...server,
        enabled,
      });
      setServers((current) => current.map((item) => (item.id === server.id ? updated : item)));
    } catch (updateError) {
      setError(errorMessage(updateError));
    } finally {
      setBusyId(undefined);
    }
  }

  async function remove(server: AgentMcpServerDto) {
    setBusyId(server.id);
    setError(undefined);
    try {
      await deleteAgentMcpServer(server.id);
      setServers((current) => current.filter((item) => item.id !== server.id));
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setBusyId(undefined);
    }
  }

  async function test(server: AgentMcpServerDto) {
    setBusyId(server.id);
    setError(undefined);
    try {
      const tools = await testAgentMcpServer(server.id);
      setTestResults((current) => ({
        ...current,
        [server.id]: `${tools.length} ${tools.length === 1 ? "tool" : "tools"} available`,
      }));
    } catch (testError) {
      setTestResults((current) => ({
        ...current,
        [server.id]: errorMessage(testError),
      }));
    } finally {
      setBusyId(undefined);
    }
  }

  function openCreate() {
    setEditing(undefined);
    setDraft(EMPTY_DRAFT);
    setSaveError(undefined);
    setAddOpen(true);
  }

  function openEdit(server: AgentMcpServerDto) {
    setEditing(server);
    setDraft({
      name: server.name,
      transport: server.transport,
      command: server.command ?? "",
      args: server.args.join("\n"),
      url: server.url ?? "",
      env: "",
      headers: "",
      includeTools: server.toolVisibility.include.join("\n"),
      excludeTools: server.toolVisibility.exclude.join("\n"),
      approvalTools: server.safety.approvalTools.join("\n"),
      requiresApproval: server.safety.requiresApproval,
      allowSandboxed: server.safety.allowSandboxed,
    });
    setSaveError(undefined);
    setAddOpen(true);
  }

  async function save() {
    setSaveError(undefined);
    try {
      const secretBundle = {
        env: parseSecretMap(draft.env, "Environment"),
        headers: parseSecretMap(draft.headers, "Headers"),
      };
      const input = {
        id: editing?.id,
        name: draft.name.trim(),
        enabled: editing?.enabled ?? true,
        transport: draft.transport,
        command: draft.transport === "stdio" ? draft.command.trim() : undefined,
        args:
          draft.transport === "stdio"
            ? draft.args
                .split("\n")
                .map((value) => value.trim())
                .filter(Boolean)
            : [],
        url: draft.transport === "streamable_http" ? draft.url.trim() : undefined,
        metadata: editing?.metadata ?? {},
        toolVisibility: {
          include: splitLines(draft.includeTools),
          exclude: splitLines(draft.excludeTools),
        },
        safety: {
          ...(editing?.safety ?? DEFAULT_AGENT_MCP_SAFETY),
          requiresApproval: draft.requiresApproval,
          allowSandboxed: draft.allowSandboxed,
          approvalTools: splitLines(draft.approvalTools),
        },
        ...(!editing ||
        Object.keys(secretBundle.env).length ||
        Object.keys(secretBundle.headers).length
          ? { secrets: secretBundle }
          : {}),
      };
      const saved = editing
        ? await updateAgentMcpServer({ ...input, id: editing.id })
        : await createAgentMcpServer(input);
      setServers((current) =>
        (editing
          ? current.map((server) => (server.id === editing.id ? saved : server))
          : [...current, saved]
        ).sort((a, b) => a.name.localeCompare(b.name)),
      );
      setDraft(EMPTY_DRAFT);
      setEditing(undefined);
      setAddOpen(false);
    } catch (createError) {
      setSaveError(errorMessage(createError));
    }
  }

  function splitLines(value: string) {
    return value
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return (
    <section className="settings-group" aria-labelledby="mcp-servers-heading">
      <div className="settings-group-header">
        <h3 id="mcp-servers-heading" className="settings-group-heading">
          Custom MCP servers
        </h3>
        <button type="button" className="btn btn-secondary" onClick={openCreate}>
          <IconPlusMedium size={14} />
          Add server
        </button>
      </div>
      <p className="settings-group-description">
        Add local or remote tools to June. Credentials stay in your system keychain.
      </p>

      {error ? (
        <InlineNotice
          tone="warning"
          body={error}
          actions={
            <button type="button" className="btn btn-secondary" onClick={() => void load()}>
              Try again
            </button>
          }
        />
      ) : null}

      <div className="settings-card">
        <div className="settings-rows">
          {loading ? (
            <div className="settings-row">
              <p className="settings-row-description">Loading MCP servers...</p>
            </div>
          ) : servers.length === 0 ? (
            <div className="settings-row">
              <div className="settings-row-info">
                <h4 className="settings-row-title">No custom servers</h4>
                <p className="settings-row-description">
                  Connected plugins still work. Add a custom server when you need another tool.
                </p>
              </div>
            </div>
          ) : (
            servers.map((server) => (
              <div className="settings-row" key={server.id}>
                <div className="settings-row-info">
                  <h4 className="settings-row-title">{server.name}</h4>
                  <p className="settings-row-description">
                    {server.transport === "stdio" ? server.command : server.url}
                    {server.metadata.needsReview === true ? " - Needs review" : ""}
                    {testResults[server.id] ? ` · ${testResults[server.id]}` : ""}
                  </p>
                </div>
                <div className="settings-row-control">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Configure ${server.name}`}
                    disabled={busyId === server.id}
                    onClick={() => openEdit(server)}
                  >
                    <IconSettingsGear4 size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Test ${server.name}`}
                    disabled={busyId === server.id}
                    onClick={() => void test(server)}
                  >
                    <IconArrowRotateClockwise size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Delete ${server.name}`}
                    disabled={busyId === server.id}
                    onClick={() => setToDelete(server)}
                  >
                    <IconTrashCan size={14} />
                  </button>
                  <Switch
                    checked={server.enabled}
                    disabled={busyId === server.id}
                    aria-label={`${server.name} enabled`}
                    onCheckedChange={(enabled) => void toggle(server, enabled)}
                  />
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <Dialog
        open={addOpen}
        onClose={() => {
          setAddOpen(false);
          setEditing(undefined);
        }}
        title={editing ? `Configure ${editing.name}` : "Add MCP server"}
        description={
          editing
            ? "Blank secret fields keep the credentials already saved in your system keychain."
            : "June discovers tools directly from this server. Secret values are saved only in your system keychain."
        }
        footer={
          <>
            <button
              type="button"
              className="primary-action"
              onClick={() => {
                setAddOpen(false);
                setEditing(undefined);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={!draft.name.trim()}
              onClick={() => void save()}
            >
              {editing ? "Save changes" : "Add server"}
            </button>
          </>
        }
      >
        <div className="dialog-body">
          {saveError ? <InlineNotice tone="warning" body={saveError} /> : null}
          <label className="dialog-field">
            Name
            <input
              className="dialog-input"
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
          </label>
          <label className="dialog-field">
            Transport
            <select
              className="dialog-input"
              value={draft.transport}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  transport: event.target.value as AgentMcpTransport,
                }))
              }
            >
              <option value="stdio">Local process (stdio)</option>
              <option value="streamable_http">Streamable HTTP</option>
            </select>
          </label>
          {draft.transport === "stdio" ? (
            <>
              <label className="dialog-field">
                Command
                <input
                  className="dialog-input"
                  value={draft.command}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, command: event.target.value }))
                  }
                />
              </label>
              <label className="dialog-field">
                Arguments, one per line
                <textarea
                  className="dialog-textarea"
                  value={draft.args}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, args: event.target.value }))
                  }
                />
              </label>
            </>
          ) : (
            <label className="dialog-field">
              URL
              <input
                className="dialog-input"
                value={draft.url}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, url: event.target.value }))
                }
              />
            </label>
          )}
          <label className="dialog-field">
            Environment variables (JSON)
            <textarea
              className="dialog-textarea"
              placeholder={'{"TOKEN":"..."}'}
              value={draft.env}
              onChange={(event) => setDraft((current) => ({ ...current, env: event.target.value }))}
            />
          </label>
          <label className="dialog-field">
            HTTP headers (JSON)
            <textarea
              className="dialog-textarea"
              placeholder={'{"Authorization":"Bearer ..."}'}
              value={draft.headers}
              onChange={(event) =>
                setDraft((current) => ({ ...current, headers: event.target.value }))
              }
            />
          </label>
          <label className="dialog-field">
            Allowed tools, one per line
            <textarea
              className="dialog-textarea"
              placeholder="Leave blank to allow every discovered tool"
              value={draft.includeTools}
              onChange={(event) =>
                setDraft((current) => ({ ...current, includeTools: event.target.value }))
              }
            />
          </label>
          <label className="dialog-field">
            Blocked tools, one per line
            <textarea
              className="dialog-textarea"
              value={draft.excludeTools}
              onChange={(event) =>
                setDraft((current) => ({ ...current, excludeTools: event.target.value }))
              }
            />
          </label>
          <label className="dialog-field">
            Tools that require approval, one per line
            <textarea
              className="dialog-textarea"
              value={draft.approvalTools}
              disabled={draft.requiresApproval}
              onChange={(event) =>
                setDraft((current) => ({ ...current, approvalTools: event.target.value }))
              }
            />
          </label>
          <div className="settings-card">
            <div className="settings-rows">
              <div className="settings-row">
                <span className="settings-row-title">Require approval for every tool</span>
                <Switch
                  checked={draft.requiresApproval}
                  aria-label="Require approval for every tool"
                  onCheckedChange={(value) =>
                    setDraft((current) => ({ ...current, requiresApproval: value }))
                  }
                />
              </div>
              <div className="settings-row">
                <span className="settings-row-title">
                  Allow in Sandboxed sessions
                  {draft.transport === "stdio" ? " on macOS" : ""}
                </span>
                <Switch
                  checked={draft.allowSandboxed}
                  aria-label="Allow in Sandboxed sessions"
                  onCheckedChange={(value) =>
                    setDraft((current) => ({ ...current, allowSandboxed: value }))
                  }
                />
              </div>
            </div>
          </div>
        </div>
      </Dialog>
      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(undefined)}
        onConfirm={() => (toDelete ? remove(toDelete) : undefined)}
        title={toDelete ? `Delete ${toDelete.name}?` : "Delete MCP server?"}
        description="June will remove this server and its keychain credentials. This cannot be undone."
        confirmLabel="Delete server"
        confirmBusyLabel="Deleting..."
        destructive
      />
    </section>
  );
}
