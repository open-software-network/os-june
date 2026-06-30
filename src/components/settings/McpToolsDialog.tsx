import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconCircleX } from "central-icons/IconCircleX";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconShield } from "central-icons/IconShield";
import { useEffect, useId, useMemo, useState } from "react";
import {
  buildToolPolicyBlock,
  compareToolPolicy,
  draftFromServer,
  precedenceNote,
  shouldRecommendAllowlist,
  type HermesMcpServerInfo,
  type HermesMcpTestResult,
  type ToolFilterMode,
  type ToolPolicyDraft,
  type UtilityToggle,
} from "../../lib/hermes-admin";
import { Dialog } from "../ui/Dialog";

/**
 * The per-server "Tools" panel (spec 16): configure a server's tool selection /
 * filtering policy. Shows the tools discovered from the last test (test-time
 * discovery, labelled), lets the user choose an allowlist or blocklist (with
 * INCLUDE-WINS precedence made explicit), toggle the resource / prompt utility
 * tools, set parallel-tool-calls and timeouts, and previews the effect with the
 * "Server exposes / June will expose / Blocked/destructive" compare counts.
 *
 * Destructive-looking tools are highlighted for review (reusing spec 19's
 * detector). Saving writes ONLY the scoped `mcp_servers.<name>.tools` block, so
 * the gateway-restart requirement is shown after a change. The component is
 * presentation + local draft state; the write + preservation live in the
 * controller.
 */
export function McpToolsDialog({
  server,
  testResult,
  saving,
  saveError,
  onClose,
  onSave,
}: {
  /** The server whose tools are being configured, or undefined when closed. */
  server?: HermesMcpServerInfo;
  /** The last test probe for this server, for test-time tool discovery. */
  testResult?: HermesMcpTestResult;
  /** True while this server's policy save is in flight. */
  saving: boolean;
  /** The safe message from the last failed save, or undefined. */
  saveError?: string;
  onClose: () => void;
  /** Persists the draft. Resolves true on success (the dialog then closes). */
  onSave: (draft: ToolPolicyDraft) => Promise<boolean>;
}) {
  return (
    <Dialog
      open={Boolean(server)}
      onClose={saving ? () => {} : onClose}
      title={server ? `Tools for ${server.name}` : "Tools"}
      description="Choose which of this server's tools the agent can use. Changes apply after the Hermes gateway restarts."
      width={620}
      className="mcp-tools-dialog"
    >
      {server ? (
        <McpToolsForm
          key={server.name}
          server={server}
          testResult={testResult}
          saving={saving}
          saveError={saveError}
          onClose={onClose}
          onSave={onSave}
        />
      ) : null}
    </Dialog>
  );
}

/** The editable form. Split out so it remounts per server (via `key`) and starts
 * from that server's stored policy. */
function McpToolsForm({
  server,
  testResult,
  saving,
  saveError,
  onClose,
  onSave,
}: {
  server: HermesMcpServerInfo;
  testResult?: HermesMcpTestResult;
  saving: boolean;
  saveError?: string;
  onClose: () => void;
  onSave: (draft: ToolPolicyDraft) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<ToolPolicyDraft>(() =>
    draftFromServer(server),
  );
  const [saved, setSaved] = useState(false);
  const headingId = useId();

  // A fresh save notice clears as soon as the user edits again.
  useEffect(() => {
    setSaved(false);
  }, [draft]);

  const comparison = useMemo(
    () => compareToolPolicy(server, draft, testResult),
    [server, draft, testResult],
  );
  const precedence = useMemo(() => precedenceNote(draft), [draft]);
  const recommendAllowlist = shouldRecommendAllowlist(comparison);

  const block = buildToolPolicyBlock(draft);
  const includeText = (draft.include ?? []).join("\n");
  const excludeText = (draft.exclude ?? []).join("\n");

  function setMode(mode: ToolFilterMode) {
    setDraft((d) => ({ ...d, mode }));
  }

  function toggleToolInList(name: string) {
    // Clicking a tool in allowlist mode adds/removes it from the include list;
    // in blocklist mode adds/removes it from the exclude list.
    setDraft((d) => {
      if (d.mode === "allowlist") {
        const present = d.include.includes(name);
        return {
          ...d,
          include: present
            ? d.include.filter((n) => n !== name)
            : [...d.include, name],
        };
      }
      if (d.mode === "blocklist") {
        const present = d.exclude.includes(name);
        return {
          ...d,
          exclude: present
            ? d.exclude.filter((n) => n !== name)
            : [...d.exclude, name],
        };
      }
      return d;
    });
  }

  async function handleSave() {
    const ok = await onSave(draft);
    if (ok) setSaved(true);
  }

  return (
    <div className="mcp-tools-form" aria-labelledby={headingId}>
      <CompareCounts comparison={comparison} />

      {comparison.empty ? (
        <p className="mcp-tools-discovery-note" role="note">
          <IconCircleInfo size={13} ariaHidden />
          No tools discovered yet. Test the server first to list the tools it
          exposes, then choose which to allow.
        </p>
      ) : (
        <p className="mcp-tools-discovery-note" role="note">
          <IconCircleInfo size={13} ariaHidden />
          {comparison.fromTest
            ? "Tools below come from the last test of this server."
            : "Tools below come from the stored inventory. Test the server to refresh it."}
        </p>
      )}

      <fieldset className="mcp-tools-mode">
        <legend className="mcp-tools-legend">Filter mode</legend>
        <div
          className="mcp-tools-mode-options"
          role="radiogroup"
          aria-label="Filter mode"
        >
          <ModeOption
            label="Allowlist"
            hint="Expose only chosen tools. Safest for sensitive servers."
            active={draft.mode === "allowlist"}
            onSelect={() => setMode("allowlist")}
          />
          <ModeOption
            label="Blocklist"
            hint="Expose all tools except chosen ones."
            active={draft.mode === "blocklist"}
            onSelect={() => setMode("blocklist")}
          />
          <ModeOption
            label="No filter"
            hint="Expose every tool the server reports."
            active={draft.mode === "none"}
            onSelect={() => setMode("none")}
          />
        </div>
      </fieldset>

      <p
        className="mcp-tools-precedence"
        data-code={precedence.code}
        role="note"
      >
        <IconShield size={13} ariaHidden />
        {precedence.message}
      </p>

      {recommendAllowlist && draft.mode !== "allowlist" ? (
        <p className="mcp-tools-allowlist-rec" role="note">
          <IconExclamationCircle size={13} ariaHidden />
          This server exposes destructive-looking tools that the current setting
          would expose. Consider an allowlist that includes only the tools you
          need.
        </p>
      ) : null}

      {draft.mode !== "none" && comparison.tools.length > 0 ? (
        <ToolList
          mode={draft.mode}
          tools={comparison.tools}
          onToggle={toggleToolInList}
        />
      ) : null}

      {draft.mode === "allowlist" ? (
        <NameListField
          label="Allowlist (one tool per line)"
          inert={false}
          value={includeText}
          onChange={(text) =>
            setDraft((d) => ({ ...d, include: splitNames(text) }))
          }
        />
      ) : null}

      {draft.mode === "blocklist" ? (
        <NameListField
          label="Blocklist (one tool per line)"
          inert={false}
          value={excludeText}
          onChange={(text) =>
            setDraft((d) => ({ ...d, exclude: splitNames(text) }))
          }
        />
      ) : null}

      {/* When an allowlist is active but an exclude list was also entered, show
          it greyed as inert so the user sees include wins. */}
      {precedence.excludeInert ? (
        <p className="mcp-tools-inert-note" role="note">
          <IconCircleInfo size={13} ariaHidden />A blocklist is set but ignored
          while an allowlist is active. Include wins.
        </p>
      ) : null}

      <fieldset className="mcp-tools-utilities">
        <legend className="mcp-tools-legend">Utility tools</legend>
        <UtilityRow
          label="Resource tools"
          hint="Read and list the server's resources. Registered only if the server supports resources."
          value={draft.resources}
          onChange={(value) => setDraft((d) => ({ ...d, resources: value }))}
        />
        <UtilityRow
          label="Prompt tools"
          hint="Use the server's prompt templates. Registered only if the server supports prompts."
          value={draft.prompts}
          onChange={(value) => setDraft((d) => ({ ...d, prompts: value }))}
        />
      </fieldset>

      <fieldset className="mcp-tools-advanced">
        <legend className="mcp-tools-legend">Advanced</legend>
        <ParallelRow
          value={draft.supportsParallelToolCalls}
          onChange={(value) =>
            setDraft((d) => ({ ...d, supportsParallelToolCalls: value }))
          }
        />
        <SecondsRow
          label="Request timeout (seconds)"
          value={draft.timeoutSeconds}
          onChange={(value) =>
            setDraft((d) => ({ ...d, timeoutSeconds: value }))
          }
        />
        <SecondsRow
          label="Connect timeout (seconds)"
          value={draft.connectTimeoutSeconds}
          onChange={(value) =>
            setDraft((d) => ({ ...d, connectTimeoutSeconds: value }))
          }
        />
      </fieldset>

      {saveError ? (
        <p className="mcp-tools-error" role="alert">
          <IconCircleX size={13} ariaHidden />
          {saveError}
        </p>
      ) : null}

      {saved ? (
        <p className="mcp-tools-saved" role="status">
          <IconCircleCheck size={13} ariaHidden />
          Tool filter saved. Restart Hermes gateway to refresh registered tools.
        </p>
      ) : null}

      <div className="mcp-tools-actions">
        <button
          type="button"
          className="primary-action"
          onClick={onClose}
          disabled={saving}
        >
          Close
        </button>
        <button
          type="button"
          className="primary-action primary-solid"
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? "Saving" : "Save tool filter"}
        </button>
      </div>

      {/* A debug-friendly, non-secret echo of exactly what will be written, so a
          reviewer can see the scoped block. Tool names are not secret. */}
      <details className="mcp-tools-preview">
        <summary>What gets saved</summary>
        <p className="mcp-tools-preview-path">
          mcp_servers.{server.name}.tools
        </p>
        <pre className="mcp-tools-preview-block">
          {JSON.stringify(block, null, 2)}
        </pre>
      </details>
    </div>
  );
}

/** The "Server exposes / June will expose / Blocked/destructive" compare. */
function CompareCounts({
  comparison,
}: {
  comparison: ReturnType<typeof compareToolPolicy>;
}) {
  return (
    <dl className="mcp-tools-compare" aria-label="Tool exposure summary">
      <div className="mcp-tools-compare-item">
        <dt>Server exposes</dt>
        <dd>{comparison.exposed} tools</dd>
      </div>
      <div className="mcp-tools-compare-item" data-tone="ok">
        <dt>June will expose to agent</dt>
        <dd>{comparison.willExpose} tools</dd>
      </div>
      <div
        className="mcp-tools-compare-item"
        data-tone={comparison.destructiveBlocked > 0 ? "attention" : "neutral"}
      >
        <dt>Blocked/destructive</dt>
        <dd>{comparison.destructiveBlocked} tools</dd>
      </div>
    </dl>
  );
}

function ModeOption({
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
      className="mcp-tools-mode-option"
      data-active={active}
      onClick={onSelect}
    >
      <span className="mcp-tools-mode-label">{label}</span>
      <span className="mcp-tools-mode-hint">{hint}</span>
    </button>
  );
}

/** The discovered tools list, each row clickable to add/remove from the active
 * list, with allowed state and a destructive highlight. */
function ToolList({
  mode,
  tools,
  onToggle,
}: {
  mode: ToolFilterMode;
  tools: ReturnType<typeof compareToolPolicy>["tools"];
  onToggle: (name: string) => void;
}) {
  return (
    <ul className="mcp-tools-list" aria-label="Discovered tools">
      {tools.map((tool) => (
        <li
          key={tool.name}
          className="mcp-tools-row"
          data-allowed={tool.allowed}
          data-destructive={tool.destructive}
        >
          <button
            type="button"
            className="mcp-tools-row-toggle"
            aria-pressed={tool.allowed}
            title={
              mode === "allowlist"
                ? tool.allowed
                  ? "Allowed. Click to remove from the allowlist."
                  : "Not allowed. Click to add to the allowlist."
                : tool.allowed
                  ? "Allowed. Click to add to the blocklist."
                  : "Blocked. Click to remove from the blocklist."
            }
            onClick={() => onToggle(tool.name)}
          >
            <span className="mcp-tools-row-state" aria-hidden>
              {tool.allowed ? (
                <IconCircleCheck size={13} />
              ) : (
                <IconCircleX size={13} />
              )}
            </span>
            <span className="mcp-tools-row-name">{tool.name}</span>
            {tool.destructive ? (
              <span className="mcp-tools-row-destructive" title="Destructive">
                <IconExclamationCircle size={11} ariaHidden />
                Destructive
              </span>
            ) : null}
          </button>
          {tool.description ? (
            <p className="mcp-tools-row-desc">{tool.description}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function NameListField({
  label,
  value,
  inert,
  onChange,
}: {
  label: string;
  value: string;
  inert: boolean;
  onChange: (text: string) => void;
}) {
  const id = useId();
  return (
    <fieldset className="mcp-tools-namelist" data-inert={inert}>
      <label className="mcp-tools-legend" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="mcp-tools-textarea"
        rows={3}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </fieldset>
  );
}

function UtilityRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: UtilityToggle;
  onChange: (value: UtilityToggle) => void;
}) {
  const id = useId();
  return (
    <div className="mcp-tools-utility-row">
      <div className="mcp-tools-utility-head">
        <label className="mcp-tools-utility-label" htmlFor={id}>
          {label}
        </label>
        <select
          id={id}
          className="mcp-tools-select"
          value={value}
          onChange={(event) =>
            onChange(event.currentTarget.value as UtilityToggle)
          }
        >
          <option value="default">Default</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </div>
      <p className="mcp-tools-utility-hint">{hint}</p>
    </div>
  );
}

/** The parallel-tool-calls control, a tri-state so an unset value stays unset. */
function ParallelRow({
  value,
  onChange,
}: {
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
}) {
  const id = useId();
  const selected = value === undefined ? "default" : value ? "on" : "off";
  return (
    <div className="mcp-tools-utility-row">
      <div className="mcp-tools-utility-head">
        <label className="mcp-tools-utility-label" htmlFor={id}>
          Parallel tool calls
        </label>
        <select
          id={id}
          className="mcp-tools-select"
          value={selected}
          onChange={(event) => {
            const next = event.currentTarget.value;
            onChange(next === "default" ? undefined : next === "on");
          }}
        >
          <option value="default">Default</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </div>
      <p className="mcp-tools-utility-hint">
        Set only if this server documents support for parallel tool calls.
      </p>
    </div>
  );
}

function SecondsRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  const id = useId();
  return (
    <div className="mcp-tools-seconds-row">
      <label className="mcp-tools-utility-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={0}
        className="mcp-tools-number"
        value={value ?? ""}
        placeholder="Default"
        onChange={(event) => {
          const raw = event.currentTarget.value.trim();
          if (raw === "") {
            onChange(undefined);
            return;
          }
          const parsed = Number(raw);
          onChange(Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined);
        }}
      />
    </div>
  );
}

/** Splits a textarea into trimmed, non-empty tool names. */
function splitNames(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
