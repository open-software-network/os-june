import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconCircleX } from "central-icons/IconCircleX";
import { IconCloud } from "central-icons/IconCloud";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconServer1 } from "central-icons/IconServer1";
import { IconShield } from "central-icons/IconShield";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useId, useMemo, useState } from "react";
import {
  authMeta,
  emptyDraft,
  filterServers,
  hasAvailableTools,
  isLocalSubprocess,
  redactedEnv,
  redactedHeaders,
  serverArgs,
  statusMeta,
  transportMeta,
  useMcpServers,
  validateDraft,
  type HermesAdminMode,
  type HermesMcpServerInfo,
  type McpServerDraft,
  type McpServersState,
  type McpTestState,
} from "../../lib/hermes-admin";
import { AdminNotifications } from "./AdminNotifications";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";
import { Switch } from "../ui/Switch";

type McpServersSectionProps = {
  /** The write-access mode whose runtime this page targets. Defaults to the safe
   * sandboxed runtime; the host can point it at Full mode explicitly. */
  mode?: HermesAdminMode;
};

/**
 * June's native MCP servers page (spec 14). Lists the MCP servers Hermes has
 * configured for the targeted profile and lets the user add stdio / HTTP
 * servers, test connections, enable/disable, and delete, all through the typed
 * `hermes-admin` client, the shared cache, and the gateway lifecycle (so the
 * apply-timing copy is honest: MCP changes are "restart required").
 *
 * Secrets (env values, header values, tokens) are never surfaced. The data lives
 * entirely in {@link useMcpServers}; this component is presentation + local
 * filter / dialog state.
 */
export function McpServersSection({
  mode = "sandboxed",
}: McpServersSectionProps) {
  const state = useMcpServers(mode);
  return <McpServersView state={state} mode={mode} />;
}

/**
 * The render-only view, split out so component tests can drive it with a stubbed
 * {@link McpServersState} (no Tauri, no network) and assert search / add / test /
 * toggle / delete wiring. Owns only the local search + dialog state.
 */
export function McpServersView({
  state,
  mode = "sandboxed",
}: {
  state: McpServersState;
  mode?: HermesAdminMode;
}) {
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [toDelete, setToDelete] = useState<HermesMcpServerInfo | undefined>();

  const visible = useMemo(
    () => filterServers(state.servers, query),
    [state.servers, query],
  );

  const isUnavailable = state.status === "unavailable";
  const isErrored = state.status === "error";
  const isLoadingFirst = state.status === "loading";
  const hasServers = state.servers.length > 0;

  return (
    <section
      className="settings-group mcp-servers"
      aria-labelledby="mcp-servers-heading"
    >
      <h2 id="mcp-servers-heading" className="settings-group-heading">
        MCP servers
      </h2>
      <p className="settings-group-description">
        Connect Model Context Protocol servers so future sessions can use their
        tools. Changes apply after the Hermes gateway restarts.{" "}
        <ModeNote
          mode={state.mode ?? mode}
          profile={state.profile}
          show={!isUnavailable}
        />
      </p>

      <LifecycleBanner state={state} />
      <AdminNotifications
        notifications={state.notifications}
        onDismiss={state.dismissNotification}
      />

      <div className="settings-card mcp-servers-card">
        <div className="mcp-servers-toolbar">
          <div className="mcp-servers-search">
            <IconMagnifyingGlass
              size={15}
              ariaHidden
              className="mcp-servers-search-icon"
            />
            <input
              type="search"
              value={query}
              placeholder="Filter servers"
              aria-label="Filter MCP servers"
              disabled={isUnavailable}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <button
            type="button"
            className="mcp-servers-refresh"
            disabled={isUnavailable || isLoadingFirst}
            onClick={state.refresh}
          >
            <IconArrowRotateClockwise size={14} ariaHidden />
            Refresh
          </button>
          <button
            type="button"
            className="btn btn-primary mcp-servers-add"
            disabled={isUnavailable}
            onClick={() => setAddOpen(true)}
          >
            <IconPlusMedium size={14} ariaHidden />
            Add server
          </button>
        </div>

        {state.error && hasServers ? (
          <p className="settings-row-error mcp-servers-inline-error">
            <IconExclamationCircle size={14} ariaHidden />
            {state.error}
          </p>
        ) : null}

        <div className="mcp-servers-body">
          {isUnavailable ? (
            <EmptyState
              title="Hermes is not running"
              description="Start Hermes to see and manage the MCP servers your sessions can use."
            />
          ) : isErrored ? (
            <ErrorState
              message={state.error ?? "Could not load MCP servers from Hermes."}
              retryable={state.retryable}
              onRetry={state.refresh}
            />
          ) : isLoadingFirst ? (
            <ServersLoading />
          ) : !hasServers ? (
            <EmptyState
              title="No MCP servers"
              description="Add a server to connect external tools. Local (stdio) servers run as subprocesses; remote servers connect over HTTP."
            />
          ) : visible.length === 0 ? (
            <EmptyState
              title="No matching servers"
              description="No server matches your search. Try a different term."
            />
          ) : (
            <ul className="mcp-servers-list">
              {visible.map((server) => (
                <ServerRow
                  key={server.name}
                  server={server}
                  pending={state.pending.has(server.name)}
                  test={state.tests.get(server.name)}
                  onToggle={(enabled) => state.setEnabled(server.name, enabled)}
                  onTest={() => void state.test(server.name)}
                  onDelete={() => setToDelete(server)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <AddServerDialog
        open={addOpen}
        adding={state.adding}
        existingNames={state.servers.map((server) => server.name)}
        onClose={() => setAddOpen(false)}
        onAdd={async (payload) => {
          const ok = await state.add(payload);
          if (ok) setAddOpen(false);
          return ok;
        }}
      />

      <DeleteServerDialog
        server={toDelete}
        onClose={() => setToDelete(undefined)}
        onConfirm={async () => {
          if (toDelete) await state.remove(toDelete.name);
        }}
      />
    </section>
  );
}

/** The sandbox/full-mode + profile context line. */
function ModeNote({
  mode,
  profile,
  show,
}: {
  mode: HermesAdminMode;
  profile?: string;
  show: boolean;
}) {
  if (!show) return null;
  const modeLabel = mode === "unrestricted" ? "Full mode" : "Sandboxed";
  return (
    <span className="mcp-servers-mode-note">
      Targeting the {modeLabel} runtime
      {profile ? ` (profile ${profile})` : ""}.
    </span>
  );
}

/** The shared gateway-lifecycle banner. MCP changes are restart-required, so
 * this surfaces the restart state once a change is pending. */
function LifecycleBanner({ state }: { state: McpServersState }) {
  const snapshot = state.lifecycle;
  if (state.status === "unavailable") return null;
  if (snapshot.state === "clean") return null;
  const tone =
    snapshot.state === "restart-failed"
      ? "destructive"
      : snapshot.state === "gateway-restart-required" ||
          snapshot.state === "active-session-should-restart"
        ? "warning"
        : "info";
  return (
    <div className="mcp-servers-lifecycle" data-tone={tone} role="status">
      <span className="mcp-servers-lifecycle-eyebrow">
        <IconCircleInfo size={15} ariaHidden />
        {snapshot.label}
      </span>
      <span className="mcp-servers-lifecycle-body">{snapshot.detail}</span>
    </div>
  );
}

/** One MCP server row: name + transport / risk pills, connection target
 * (command + args or URL), auth and last-test status, redacted secret fields,
 * discovered tools, a test button, the enable/disable toggle, and a delete
 * action. */
function ServerRow({
  server,
  pending,
  test,
  onToggle,
  onTest,
  onDelete,
}: {
  server: HermesMcpServerInfo;
  pending: boolean;
  test?: McpTestState;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const transport = transportMeta(server.transport);
  const auth = authMeta(server.auth);
  const status = statusMeta(server.status);
  const env = redactedEnv(server);
  const headers = redactedHeaders(server);
  const args = serverArgs(server);
  const local = isLocalSubprocess(server);
  const labelId = `mcp-server-${cssId(server.name)}`;
  const tools = test?.result?.tools ?? server.tools ?? [];

  return (
    <li className="mcp-server-row" data-enabled={server.enabled}>
      <div className="mcp-server-main">
        <div className="mcp-server-headline">
          <span className="mcp-server-name" id={labelId}>
            {server.name}
          </span>
          <span className="mcp-server-transport" data-risk={transport.risk}>
            {transport.label}
          </span>
          <span className="mcp-server-risk" data-risk={transport.risk}>
            <IconShield size={12} ariaHidden />
            {transport.riskLabel}
          </span>
          {server.auth !== "not-required" ? (
            <span className="mcp-server-auth" data-tone={auth.tone}>
              {auth.label}
            </span>
          ) : null}
        </div>

        <p className="mcp-server-target" title={server.command ?? server.url}>
          {server.transport === "stdio"
            ? formatCommand(server.command, args)
            : (server.url ?? "No URL configured.")}
        </p>

        <p className="mcp-server-blurb">{transport.blurb}</p>

        <div className="mcp-server-meta">
          <span className="mcp-server-status" data-tone={status.tone}>
            <StatusIcon tone={status.tone} />
            {status.label}
          </span>
          {server.statusMessage ? (
            <span className="mcp-server-status-detail">
              {server.statusMessage}
            </span>
          ) : null}
        </div>

        {env.length > 0 || headers.length > 0 ? (
          <div className="mcp-server-secrets">
            {env.length > 0 ? (
              <SecretSummary label="Environment" count={env.length} />
            ) : null}
            {headers.length > 0 ? (
              <SecretSummary label="Headers" count={headers.length} />
            ) : null}
          </div>
        ) : null}

        <TestResult test={test} tools={tools} />
      </div>

      <div className="mcp-server-actions">
        <button
          type="button"
          className="mcp-server-test"
          disabled={test?.pending}
          onClick={onTest}
        >
          {test?.pending ? "Testing" : "Test"}
        </button>
        <button
          type="button"
          className="mcp-server-delete"
          aria-label={`Delete ${server.name}`}
          title="Delete server"
          disabled={pending}
          onClick={onDelete}
        >
          <IconTrashCan size={14} ariaHidden />
        </button>
        <span className="mcp-server-toggle">
          <Switch
            checked={server.enabled}
            disabled={pending}
            aria-labelledby={labelId}
            onCheckedChange={onToggle}
          />
          <span className="mcp-server-timing" aria-hidden>
            {pending ? "Saving" : "Restart to apply"}
          </span>
        </span>
      </div>
    </li>
  );
}

/** A redacted summary of secret-bearing config: a count and a placeholder, never
 * the values. */
function SecretSummary({ label, count }: { label: string; count: number }) {
  return (
    <span
      className="mcp-server-secret"
      title={`${count} hidden ${label.toLowerCase()}`}
    >
      {label}: {count} hidden
    </span>
  );
}

/** The discovered tools / error from the last test probe. */
function TestResult({
  test,
  tools,
}: {
  test?: McpTestState;
  tools: { name: string; description?: string }[];
}) {
  if (!test || test.pending) return null;
  if (test.error) {
    return (
      <p className="mcp-server-test-error" role="alert">
        <IconExclamationCircle size={13} ariaHidden />
        {test.error}
      </p>
    );
  }
  const result = test.result;
  if (!result) return null;
  if (!result.ok) {
    return (
      <p className="mcp-server-test-error" role="alert">
        <IconCircleX size={13} ariaHidden />
        {result.message ?? "Could not connect to the server."}
      </p>
    );
  }
  return (
    <div className="mcp-server-test-ok" role="status">
      <p className="mcp-server-test-ok-line">
        <IconCircleCheck size={13} ariaHidden />
        Connected.{" "}
        {tools.length > 0
          ? `Discovered ${tools.length} ${tools.length === 1 ? "tool" : "tools"}.`
          : "No tools reported."}
      </p>
      {tools.length > 0 ? (
        <ul className="mcp-server-test-tools">
          {tools.map((tool) => (
            <li key={tool.name} title={tool.description}>
              {tool.name}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StatusIcon({ tone }: { tone: "ok" | "error" | "neutral" }) {
  if (tone === "ok") return <IconCircleCheck size={13} ariaHidden />;
  if (tone === "error") return <IconCircleX size={13} ariaHidden />;
  return <IconCircleInfo size={13} ariaHidden />;
}

/** Renders the connection target for a stdio server: command plus its args. */
function formatCommand(command: string | undefined, args: string[]): string {
  if (!command) return "No command configured.";
  return args.length > 0 ? `${command} ${args.join(" ")}` : command;
}

// ---------------------------------------------------------------------------
// Add-server dialog
// ---------------------------------------------------------------------------

function AddServerDialog({
  open,
  adding,
  existingNames,
  onClose,
  onAdd,
}: {
  open: boolean;
  adding: boolean;
  existingNames: string[];
  onClose: () => void;
  onAdd: (
    payload: import("../../lib/hermes-admin").HermesAddMcpServerPayload,
  ) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<McpServerDraft>(() => emptyDraft());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const headingId = useId();

  function reset() {
    setDraft(emptyDraft());
    setErrors({});
  }

  function handleClose() {
    if (adding) return;
    reset();
    onClose();
  }

  async function handleSubmit() {
    const trimmedName = draft.name.trim();
    if (existingNames.includes(trimmedName)) {
      setErrors({ name: "A server with this name already exists." });
      return;
    }
    const result = validateDraft(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    const ok = await onAdd(result.payload);
    if (ok) reset();
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Add MCP server"
      description="Connect a stdio or HTTP server. It becomes available to new sessions after the Hermes gateway restarts."
      width={560}
      className="mcp-add-dialog"
      footer={
        <>
          <button
            type="button"
            className="primary-action"
            onClick={handleClose}
            disabled={adding}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={() => void handleSubmit()}
            disabled={adding}
          >
            {adding ? "Adding" : "Add server"}
          </button>
        </>
      }
    >
      <div className="mcp-add-form" aria-labelledby={headingId}>
        <fieldset className="mcp-add-field">
          <label className="mcp-add-label" htmlFor="mcp-add-name">
            Name
          </label>
          <input
            id="mcp-add-name"
            type="text"
            className="mcp-add-input"
            value={draft.name}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(errors.name)}
            onChange={(event) =>
              setDraft((d) => ({ ...d, name: event.currentTarget.value }))
            }
          />
          {errors.name ? <p className="mcp-add-error">{errors.name}</p> : null}
        </fieldset>

        <fieldset className="mcp-add-field">
          <span className="mcp-add-label">Transport</span>
          <div
            className="mcp-add-transport"
            role="radiogroup"
            aria-label="Transport"
          >
            <TransportOption
              label="Local (stdio)"
              hint="Runs a local subprocess"
              active={draft.transport === "stdio"}
              onSelect={() => setDraft((d) => ({ ...d, transport: "stdio" }))}
            />
            <TransportOption
              label="Remote (HTTP)"
              hint="Connects over HTTP"
              active={draft.transport === "http"}
              onSelect={() => setDraft((d) => ({ ...d, transport: "http" }))}
            />
          </div>
        </fieldset>

        {draft.transport === "stdio" ? (
          <p className="mcp-add-note">
            <IconShield size={13} ariaHidden />
            Local servers run as subprocesses and inherit June and Hermes
            sandbox constraints. Enter only the program path here; put arguments
            in their own rows.
          </p>
        ) : null}

        {draft.transport === "stdio" ? (
          <>
            <fieldset className="mcp-add-field">
              <label className="mcp-add-label" htmlFor="mcp-add-command">
                Command
              </label>
              <input
                id="mcp-add-command"
                type="text"
                className="mcp-add-input"
                value={draft.command}
                placeholder="mcp-server-filesystem"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(errors.command)}
                onChange={(event) =>
                  setDraft((d) => ({
                    ...d,
                    command: event.currentTarget.value,
                  }))
                }
              />
              {errors.command ? (
                <p className="mcp-add-error">{errors.command}</p>
              ) : null}
            </fieldset>

            <ListEditor
              legend="Arguments"
              addLabel="Add argument"
              values={draft.args}
              errorPrefix="args"
              errors={errors}
              onChange={(args) => setDraft((d) => ({ ...d, args }))}
            />

            <PairEditor
              legend="Environment variables"
              addLabel="Add variable"
              keyPlaceholder="VAR_NAME"
              valuePlaceholder="Value (hidden)"
              pairs={draft.env}
              errorPrefix="env"
              errors={errors}
              onChange={(env) => setDraft((d) => ({ ...d, env }))}
            />
          </>
        ) : (
          <>
            <fieldset className="mcp-add-field">
              <label className="mcp-add-label" htmlFor="mcp-add-url">
                URL
              </label>
              <input
                id="mcp-add-url"
                type="url"
                className="mcp-add-input"
                value={draft.url}
                placeholder="https://example.com/mcp"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(errors.url)}
                onChange={(event) =>
                  setDraft((d) => ({ ...d, url: event.currentTarget.value }))
                }
              />
              {errors.url ? (
                <p className="mcp-add-error">{errors.url}</p>
              ) : null}
            </fieldset>

            <fieldset className="mcp-add-field">
              <label className="mcp-add-label" htmlFor="mcp-add-auth">
                Auth
              </label>
              <select
                id="mcp-add-auth"
                className="mcp-add-input"
                value={draft.auth}
                onChange={(event) =>
                  setDraft((d) => ({
                    ...d,
                    auth: event.currentTarget.value as McpServerDraft["auth"],
                  }))
                }
              >
                <option value="none">None</option>
                <option value="bearer">Bearer token</option>
                <option value="oauth">OAuth</option>
              </select>
            </fieldset>

            {draft.auth === "oauth" ? (
              <p className="mcp-add-note">
                <IconCloud size={13} ariaHidden />
                You will sign in to this server after it is added. The sign-in
                flow opens in your browser.
              </p>
            ) : null}

            <PairEditor
              legend="Headers"
              addLabel="Add header"
              keyPlaceholder="Authorization"
              valuePlaceholder="Value (hidden)"
              pairs={draft.headers}
              errorPrefix="headers"
              errors={errors}
              onChange={(headers) => setDraft((d) => ({ ...d, headers }))}
            />
          </>
        )}
      </div>
    </Dialog>
  );
}

function TransportOption({
  label,
  hint,
  active,
  onSelect,
}: {
  label: string;
  hint: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className="mcp-add-transport-option"
      data-active={active}
      onClick={onSelect}
    >
      <span className="mcp-add-transport-label">{label}</span>
      <span className="mcp-add-transport-hint">{hint}</span>
    </button>
  );
}

/** A simple add/remove list-of-strings editor (for stdio args). */
function ListEditor({
  legend,
  addLabel,
  values,
  errorPrefix,
  errors,
  onChange,
}: {
  legend: string;
  addLabel: string;
  values: string[];
  errorPrefix: string;
  errors: Record<string, string>;
  onChange: (values: string[]) => void;
}) {
  return (
    <fieldset className="mcp-add-field">
      <span className="mcp-add-label">{legend}</span>
      {values.map((value, index) => (
        <div key={index} className="mcp-add-row">
          <input
            type="text"
            className="mcp-add-input"
            value={value}
            aria-label={`${legend} ${index + 1}`}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(errors[`${errorPrefix}.${index}`])}
            onChange={(event) => {
              const next = [...values];
              next[index] = event.currentTarget.value;
              onChange(next);
            }}
          />
          <button
            type="button"
            className="mcp-add-row-remove"
            aria-label={`Remove ${legend} ${index + 1}`}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          >
            <IconCrossSmall size={13} ariaHidden />
          </button>
          {errors[`${errorPrefix}.${index}`] ? (
            <p className="mcp-add-error">{errors[`${errorPrefix}.${index}`]}</p>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        className="mcp-add-row-add"
        onClick={() => onChange([...values, ""])}
      >
        <IconPlusMedium size={13} ariaHidden />
        {addLabel}
      </button>
    </fieldset>
  );
}

/** A key/value pair editor (for stdio env and HTTP headers). Values are
 * secret-class: the value inputs are masked. */
function PairEditor({
  legend,
  addLabel,
  keyPlaceholder,
  valuePlaceholder,
  pairs,
  errorPrefix,
  errors,
  onChange,
}: {
  legend: string;
  addLabel: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  pairs: Array<{ key: string; value: string }>;
  errorPrefix: string;
  errors: Record<string, string>;
  onChange: (pairs: Array<{ key: string; value: string }>) => void;
}) {
  return (
    <fieldset className="mcp-add-field">
      <span className="mcp-add-label">{legend}</span>
      {pairs.map((pair, index) => (
        <div key={index} className="mcp-add-pair">
          <input
            type="text"
            className="mcp-add-input mcp-add-pair-key"
            value={pair.key}
            placeholder={keyPlaceholder}
            aria-label={`${legend} ${index + 1} name`}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(errors[`${errorPrefix}.${index}`])}
            onChange={(event) => {
              const next = [...pairs];
              next[index] = { ...next[index], key: event.currentTarget.value };
              onChange(next);
            }}
          />
          <input
            type="password"
            className="mcp-add-input mcp-add-pair-value"
            value={pair.value}
            placeholder={valuePlaceholder}
            aria-label={`${legend} ${index + 1} value`}
            autoComplete="off"
            onChange={(event) => {
              const next = [...pairs];
              next[index] = {
                ...next[index],
                value: event.currentTarget.value,
              };
              onChange(next);
            }}
          />
          <button
            type="button"
            className="mcp-add-row-remove"
            aria-label={`Remove ${legend} ${index + 1}`}
            onClick={() => onChange(pairs.filter((_, i) => i !== index))}
          >
            <IconCrossSmall size={13} ariaHidden />
          </button>
          {errors[`${errorPrefix}.${index}`] ? (
            <p className="mcp-add-error">{errors[`${errorPrefix}.${index}`]}</p>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        className="mcp-add-row-add"
        onClick={() => onChange([...pairs, { key: "", value: "" }])}
      >
        <IconPlusMedium size={13} ariaHidden />
        {addLabel}
      </button>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Delete confirmation
// ---------------------------------------------------------------------------

function DeleteServerDialog({
  server,
  onClose,
  onConfirm,
}: {
  server?: HermesMcpServerInfo;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const hasTools = server ? hasAvailableTools(server) : false;
  const description = server
    ? hasTools
      ? `${server.name} currently exposes tools to your sessions. Removing it drops those tools after the gateway restarts. This cannot be undone.`
      : `Remove ${server.name}? New sessions will no longer load it after the gateway restarts.`
    : "";
  return (
    <ConfirmDialog
      open={Boolean(server)}
      onClose={onClose}
      onConfirm={onConfirm}
      title={server ? `Delete "${server.name}"?` : "Delete server?"}
      description={description}
      confirmLabel="Delete server"
      destructive
    />
  );
}

// ---------------------------------------------------------------------------
// Shared empty / error / loading surfaces
// ---------------------------------------------------------------------------

function ServersLoading() {
  return (
    <ul className="mcp-servers-list" aria-hidden>
      {[0, 1].map((index) => (
        <li key={index} className="mcp-server-row mcp-server-skeleton">
          <div className="mcp-server-main">
            <span className="mcp-server-skeleton-line mcp-server-skeleton-title" />
            <span className="mcp-server-skeleton-line" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mcp-servers-empty" role="status">
      <span className="mcp-servers-empty-icon" aria-hidden>
        <IconServer1 size={22} />
      </span>
      <p className="mcp-servers-empty-title">{title}</p>
      <p className="mcp-servers-empty-description">{description}</p>
    </div>
  );
}

function ErrorState({
  message,
  retryable,
  onRetry,
}: {
  message: string;
  retryable: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mcp-servers-error" role="alert">
      <span className="mcp-servers-empty-icon" aria-hidden>
        <IconExclamationCircle size={22} />
      </span>
      <p className="mcp-servers-empty-title">Couldn't load MCP servers</p>
      <p className="mcp-servers-empty-description">{message}</p>
      {retryable ? (
        <button type="button" className="mcp-servers-retry" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** A DOM-id-safe slug of a server name for `aria-labelledby` wiring. */
function cssId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}
