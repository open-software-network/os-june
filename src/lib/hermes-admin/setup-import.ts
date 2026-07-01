/**
 * The ordered, safe import driver for a setup snapshot (spec 23). It takes a
 * parsed {@link SetupSnapshot}, the secrets the user supplied for the required
 * placeholders, and a {@link HermesAdminClient}, and applies the snapshot by
 * REUSING the existing install/config mutations (hub install, catalog install,
 * server add, enable toggles) rather than any new endpoint. It then restarts the
 * gateway when a mutation requires it and runs a post-import health check.
 *
 * The contract this driver guarantees:
 *
 * - SAFE ORDER. Install skills and MCP servers first (so the things being
 *   enabled exist), then apply enable/disable state, then restart, then health
 *   check. A later step never depends on an earlier one having not run.
 * - PARTIAL FAILURE IS REPORTED, NOT FATAL. Each step is independent: one
 *   server failing to install does not abort the rest. Every step's outcome is
 *   collected into a {@link ImportReport} the UI renders, so the user sees
 *   exactly what landed and what to retry.
 * - SECRETS COME FROM THE USER, NOT THE FILE. A snapshot carries no secret
 *   values. The driver only sends an env value when the user typed it into the
 *   supplied secrets map. Importing secrets FROM a file is not supported here;
 *   any future file-secret mode must be a separate, explicit, warned path.
 * - NO DESTRUCTIVE WRITES. An import is additive and re-configuring. It never
 *   deletes a server or uninstalls a skill the snapshot omits.
 *
 * Tool-filter note: v2026.6.19's dashboard exposes no endpoint to set
 * include/exclude on an EXISTING server (see client.ts), and `MCPServerCreate`
 * carries no filter field, so filters can only be recorded, not re-applied,
 * through this contract. The driver reports filter application as unsupported so
 * the user is not misled. When a future Hermes adds the field, the add payload
 * is the place to wire it.
 *
 * Copy is sentence case, no em/en-dashes, per June conventions.
 */

import type { HermesAddMcpServerPayload, HermesAdminClient } from "./client";
import type { HermesActionStatus } from "./schemas";
import type {
  SetupSnapshot,
  SnapshotMcpServer,
  SnapshotRequiredSecret,
  SnapshotSkill,
} from "./setup-snapshot";

/** A secret value the user supplied for a required placeholder, keyed by the
 * same `${scope}:${owner}:${key}` identity {@link requiredSecretId} produces. */
export type SuppliedSecrets = Record<string, string>;

/** A stable identity for a required secret, so a supplied value maps to it. */
export function requiredSecretId(secret: SnapshotRequiredSecret): string {
  return `${secret.scope}:${secret.owner}:${secret.key}`;
}

/** One applied step's outcome. */
export type ImportStepResult = {
  category:
    | "skill-install"
    | "skill-toggle"
    | "mcp-add"
    | "mcp-toggle"
    | "catalog-install"
    | "tool-filter"
    | "gateway-restart"
    | "health-check";
  /** The subject (skill name, server name, install name, or "gateway"). */
  name: string;
  status: "applied" | "skipped" | "failed" | "unsupported";
  /** Sentence-case detail, e.g. "Installed." or the failure reason. */
  detail: string;
};

/** The full report of an import run. */
export type ImportReport = {
  steps: ImportStepResult[];
  /** True when at least one step failed. */
  hadFailures: boolean;
  /** Whether a gateway restart was attempted. */
  restarted: boolean;
  /** The post-import health summary, when the check ran. */
  health?: {
    gatewayRunning?: boolean;
    serverCount: number;
    enabledServers: number;
  };
};

/** Options for {@link applySnapshot}. */
export type ApplyOptions = {
  /** Secrets the user supplied, keyed by {@link requiredSecretId}. */
  secrets?: SuppliedSecrets;
  /** Restart the gateway after applying when a mutation requires it. Default
   * true; a caller can defer the restart and drive it itself. */
  restartGateway?: boolean;
  /** Poll interval for backgrounded install actions. */
  pollIntervalMs?: number;
  /** Poll timeout for backgrounded install actions. */
  pollTimeoutMs?: number;
  /** Injectable sleep so tests run poll loops without real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Progress callback, fired after each step lands. */
  onStep?: (step: ImportStepResult) => void;
};

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Drives a backgrounded action to completion when the mutation returned an
 * action handle, returning the terminal status or undefined for a synchronous
 * mutation. Never throws — a poll failure becomes a failed status. */
async function settleAction(
  client: HermesAdminClient,
  action: string | undefined,
  options: ApplyOptions,
): Promise<HermesActionStatus | undefined> {
  if (!action) return undefined;
  return client.pollAction(action, {
    intervalMs: options.pollIntervalMs,
    timeoutMs: options.pollTimeoutMs,
    sleep: options.sleep,
  });
}

function buildAddPayload(
  server: SnapshotMcpServer,
  secrets: SuppliedSecrets,
): HermesAddMcpServerPayload {
  const payload: HermesAddMcpServerPayload = { name: server.name };
  if (server.command) payload.command = server.command;
  if (server.url) payload.url = server.url;
  // Re-attach ONLY the env values the user supplied for this server's keys. A
  // key with no supplied value is left out, so the server is created without it
  // and the user is told it still needs configuring.
  const env: Record<string, string> = {};
  for (const key of server.envKeys) {
    const value = secrets[`mcp-env:${server.name}:${key}`];
    if (value) env[key] = value;
  }
  if (Object.keys(env).length > 0) payload.env = env;
  return payload;
}

/**
 * Applies a parsed snapshot in safe order, reusing existing mutations, and
 * returns a full report of what landed and what failed. Every step is
 * independent so a partial failure never aborts the run.
 */
export async function applySnapshot(
  client: HermesAdminClient,
  snapshot: SetupSnapshot,
  options: ApplyOptions = {},
): Promise<ImportReport> {
  const secrets = options.secrets ?? {};
  const steps: ImportStepResult[] = [];
  let requiresRestart = false;

  const record = (step: ImportStepResult) => {
    steps.push(step);
    options.onStep?.(step);
  };

  // 1. Install hub skills first (so a later enable has something to enable).
  for (const skill of snapshot.skills.filter((s) => s.hubInstalled)) {
    try {
      const { action, requiresRestart: needsRestart } =
        await client.skills.hubInstall(skill.name);
      const status = await settleAction(client, action, options);
      if (status && status.state === "failed") {
        record({
          category: "skill-install",
          name: skill.name,
          status: "failed",
          detail: status.error ?? "The hub install failed.",
        });
      } else {
        if (needsRestart) requiresRestart = true;
        record({
          category: "skill-install",
          name: skill.name,
          status: "applied",
          detail: "Installed from the hub.",
        });
      }
    } catch (error) {
      record({
        category: "skill-install",
        name: skill.name,
        status: "failed",
        detail: errMessage(error),
      });
    }
  }

  // 2. Install catalog MCP entries (so the resulting server exists to enable).
  for (const install of snapshot.catalogInstalls) {
    try {
      const env: Record<string, string> = {};
      for (const key of install.requiredEnvKeys) {
        const value = secrets[`catalog-env:${install.installName}:${key}`];
        if (value) env[key] = value;
      }
      const { action, requiresRestart: needsRestart } =
        await client.mcp.installCatalogEntry({
          name: install.installName,
          enable: install.enabled,
          ...(Object.keys(env).length > 0 ? { env } : {}),
        });
      const status = await settleAction(client, action, options);
      if (status && status.state === "failed") {
        record({
          category: "catalog-install",
          name: install.installName,
          status: "failed",
          detail: status.error ?? "The catalog install failed.",
        });
      } else {
        if (needsRestart) requiresRestart = true;
        record({
          category: "catalog-install",
          name: install.installName,
          status: "applied",
          detail: "Installed from the catalog.",
        });
      }
    } catch (error) {
      record({
        category: "catalog-install",
        name: install.installName,
        status: "failed",
        detail: errMessage(error),
      });
    }
  }

  // 3. Add MCP servers that are not catalog installs.
  const catalogNames = new Set(
    snapshot.catalogInstalls.map((c) => c.installName),
  );
  for (const server of snapshot.mcpServers.filter(
    (s) => !catalogNames.has(s.name),
  )) {
    try {
      const { requiresRestart: needsRestart } = await client.mcp.addServer(
        buildAddPayload(server, secrets),
      );
      if (needsRestart) requiresRestart = true;
      const missing = [...server.envKeys, ...server.headerKeys].filter(
        (key) =>
          !secrets[`mcp-env:${server.name}:${key}`] &&
          !secrets[`mcp-header:${server.name}:${key}`],
      );
      record({
        category: "mcp-add",
        name: server.name,
        status: "applied",
        detail:
          missing.length > 0
            ? `Added. Still needs values for ${missing.join(", ")}.`
            : "Added.",
      });
      // Tool filters cannot be set through v2026.6.19's contract.
      if (server.includeTools.length > 0 || server.excludeTools.length > 0) {
        record({
          category: "tool-filter",
          name: server.name,
          status: "unsupported",
          detail:
            "This Hermes version cannot set tool filters over the API. Re-apply them on the MCP servers page.",
        });
      }
    } catch (error) {
      record({
        category: "mcp-add",
        name: server.name,
        status: "failed",
        detail: errMessage(error),
      });
    }
  }

  // 4. Apply enable/disable state for skills and servers (now that they exist).
  await applySkillToggles(client, snapshot.skills, record);
  requiresRestart =
    (await applyServerToggles(client, snapshot.mcpServers, record)) ||
    requiresRestart;

  // 5. Restart the gateway if any applied mutation requires it.
  let restarted = false;
  if (requiresRestart && options.restartGateway !== false) {
    try {
      const { action } = await client.gateway.restart();
      const status = await settleAction(client, action, options);
      if (status && status.state === "failed") {
        record({
          category: "gateway-restart",
          name: "gateway",
          status: "failed",
          detail: status.error ?? "The gateway restart failed.",
        });
      } else {
        restarted = true;
        record({
          category: "gateway-restart",
          name: "gateway",
          status: "applied",
          detail: "Restarted to apply the imported changes.",
        });
      }
    } catch (error) {
      record({
        category: "gateway-restart",
        name: "gateway",
        status: "failed",
        detail: errMessage(error),
      });
    }
  }

  // 6. Post-import health check.
  let health: ImportReport["health"];
  try {
    const status = await client.gateway.status();
    const servers = await client.mcp.listServers();
    health = {
      gatewayRunning: status.gatewayRunning,
      serverCount: servers.length,
      enabledServers: servers.filter((s) => s.enabled).length,
    };
    record({
      category: "health-check",
      name: "gateway",
      status: "applied",
      detail: status.gatewayRunning
        ? `Gateway is running with ${health.enabledServers} of ${health.serverCount} servers enabled.`
        : "Gateway is not running. Start it to use the imported setup.",
    });
  } catch (error) {
    record({
      category: "health-check",
      name: "gateway",
      status: "failed",
      detail: errMessage(error),
    });
  }

  return {
    steps,
    hadFailures: steps.some((step) => step.status === "failed"),
    restarted,
    health,
  };
}

async function applySkillToggles(
  client: HermesAdminClient,
  skills: readonly SnapshotSkill[],
  record: (step: ImportStepResult) => void,
): Promise<void> {
  for (const skill of skills) {
    try {
      const { result } = await client.skills.toggle(skill.name, skill.enabled);
      record({
        category: "skill-toggle",
        name: skill.name,
        status: result.ok ? "applied" : "failed",
        detail: result.ok
          ? skill.enabled
            ? "Enabled."
            : "Disabled."
          : "The toggle did not apply.",
      });
    } catch (error) {
      record({
        category: "skill-toggle",
        name: skill.name,
        status: "failed",
        detail: errMessage(error),
      });
    }
  }
}

async function applyServerToggles(
  client: HermesAdminClient,
  servers: readonly SnapshotMcpServer[],
  record: (step: ImportStepResult) => void,
): Promise<boolean> {
  let requiresRestart = false;
  for (const server of servers) {
    try {
      const { result, requiresRestart: needsRestart } =
        await client.mcp.setEnabled(server.name, server.enabled);
      if (needsRestart) requiresRestart = true;
      record({
        category: "mcp-toggle",
        name: server.name,
        status: result.ok ? "applied" : "failed",
        detail: result.ok
          ? server.enabled
            ? "Enabled."
            : "Disabled."
          : "The toggle did not apply.",
      });
    } catch (error) {
      record({
        category: "mcp-toggle",
        name: server.name,
        status: "failed",
        detail: errMessage(error),
      });
    }
  }
  return requiresRestart;
}
