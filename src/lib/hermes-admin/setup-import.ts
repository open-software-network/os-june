/**
 * Inventory-planned setup snapshot import.
 *
 * Import is deliberately additive. Before any mutation, June reads the target
 * profile's complete current inventory and builds an ordered plan. Re-importing
 * the same snapshot therefore skips work that already landed instead of
 * retrying duplicate installs or duplicate server adds. Existing MCP servers
 * with a different connection definition are reported and left untouched.
 *
 * Runtime restart is injected by the production surface. This module never
 * calls Hermes' `/api/gateway/restart` endpoint because June's Bridge owns the
 * child process and its per-spawn credentials.
 */

import type { ConfigSegmentWrite, HermesAddMcpServerPayload, HermesAdminClient } from "./client";
import { validateDraft } from "./mcp-servers-view";
import type {
  HermesActionStatus,
  HermesMcpCatalogEntry,
  HermesMcpServerInfo,
  HermesSkillInfo,
  HermesToolsetInfo,
} from "./schemas";
import { readExternalDirs } from "./schemas";
import {
  mcpServerDefinitionDifferences,
  type SetupSnapshot,
  type SnapshotMcpServer,
  type SnapshotRequiredSecret,
  type SnapshotSkill,
} from "./setup-snapshot";

export type SuppliedSecrets = Record<string, string>;

export function requiredSecretId(secret: SnapshotRequiredSecret): string {
  return `${secret.scope}:${secret.owner}:${secret.key}`;
}

export type ImportStepResult = {
  category:
    | "skill-install"
    | "skill-toggle"
    | "mcp-add"
    | "mcp-toggle"
    | "catalog-install"
    | "tool-filter"
    | "toolset-toggle"
    | "skill-config"
    | "external-dir"
    | "bundle"
    | "gateway-restart"
    | "health-check";
  name: string;
  status: "applied" | "skipped" | "failed" | "unsupported";
  detail: string;
};

export type ImportReport = {
  steps: ImportStepResult[];
  /** True when a step failed or could not be applied by this June version. */
  hadFailures: boolean;
  restarted: boolean;
  health?: {
    gatewayRunning?: boolean;
    serverCount: number;
    enabledServers: number;
  };
};

export type ApplyOptions = {
  secrets?: SuppliedSecrets;
  /** Native restart owned by June. It returns a client rebuilt from the fresh
   * Bridge status because every spawn mints a new port and token. */
  restartRuntime?: () => Promise<HermesAdminClient>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onStep?: (step: ImportStepResult) => void;
};

export type ImportInventory = {
  skills: HermesSkillInfo[];
  mcpServers: HermesMcpServerInfo[];
  catalog: HermesMcpCatalogEntry[];
  toolsets: HermesToolsetInfo[];
  config: Record<string, unknown>;
};

type PlannedOperation =
  | { kind: "skill-install"; skill: SnapshotSkill }
  | { kind: "catalog-install"; install: SetupSnapshot["catalogInstalls"][number] }
  | { kind: "mcp-add"; server: SnapshotMcpServer }
  | { kind: "skill-toggle"; skill: SnapshotSkill }
  | { kind: "mcp-toggle"; server: SnapshotMcpServer }
  | { kind: "toolset-toggle"; toolset: SetupSnapshot["readiness"]["toolsets"][number] }
  | { kind: "config-write"; write: ConfigSegmentWrite; restart: boolean };

export type ImportPlanStep = {
  category: ImportStepResult["category"];
  name: string;
  disposition: "apply" | "skip" | "unsupported";
  detail: string;
  operation?: PlannedOperation;
};

export type ImportPlan = {
  steps: ImportPlanStep[];
  requiredSecrets: SnapshotRequiredSecret[];
  changeCount: number;
};

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const right = new Set(b);
  return a.every((item) => right.has(item));
}

function configValue(config: Record<string, unknown>, segments: readonly string[]): unknown {
  let current: unknown = config;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringConfigValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function configuredToolFilters(
  config: Record<string, unknown>,
  server: HermesMcpServerInfo | undefined,
  name: string,
): { include: string[]; exclude: string[] } {
  const configured = configValue(config, ["mcp_servers", name, "tools"]);
  if (configured && typeof configured === "object" && !Array.isArray(configured)) {
    const record = configured as Record<string, unknown>;
    return {
      include: stringList(record.include) ?? [],
      exclude: stringList(record.exclude) ?? [],
    };
  }
  return {
    include: server?.includeTools ?? [],
    exclude: server?.excludeTools ?? [],
  };
}

function planStep(
  category: ImportPlanStep["category"],
  name: string,
  disposition: ImportPlanStep["disposition"],
  detail: string,
  operation?: PlannedOperation,
): ImportPlanStep {
  return { category, name, disposition, detail, ...(operation ? { operation } : {}) };
}

/** Reuses the add-server form's injection and shape checks at the file-import
 * boundary. Snapshot secret values are absent by design, so harmless marker
 * values let the validator check only their key names. */
function invalidServerDefinition(server: SnapshotMcpServer): string | undefined {
  if (
    server.transport !== "stdio" &&
    server.transport !== "http" &&
    server.transport !== "http-oauth"
  ) {
    return "The snapshot does not contain a supported server transport.";
  }
  const validation = validateDraft({
    name: server.name,
    transport: server.transport === "stdio" ? "stdio" : "http",
    command: server.command ?? "",
    args: server.args,
    env: server.envKeys.map((key) => ({ key, value: "snapshot-secret" })),
    url: server.url ?? "",
    headers: server.headerKeys.map((key) => ({ key, value: "snapshot-secret" })),
    auth: server.auth === "bearer" || server.auth === "oauth" ? server.auth : "none",
  });
  if (validation.ok) return undefined;
  return Object.values(validation.errors).join(" ");
}

/** Builds the deterministic, ordered plan used by preview tests and apply. */
export function buildImportPlan(snapshot: SetupSnapshot, live: ImportInventory): ImportPlan {
  const steps: ImportPlanStep[] = [];
  const liveSkills = new Map(live.skills.map((skill) => [skill.name, skill]));
  const liveServers = new Map(live.mcpServers.map((server) => [server.name, server]));
  const liveToolsets = new Map(live.toolsets.map((toolset) => [toolset.name, toolset]));
  const catalogNames = new Set(snapshot.catalogInstalls.map((install) => install.installName));
  const installedCatalog = new Set(
    live.catalog.filter((entry) => entry.installed).map((entry) => entry.installName),
  );
  const availableCatalog = new Set(live.catalog.map((entry) => entry.installName));
  const willCreateServers = new Set<string>();
  const conflictingServers = new Set<string>();
  const invalidServers = new Set<string>();

  // Install inventory first.
  for (const skill of snapshot.skills) {
    const current = liveSkills.get(skill.name);
    if (!skill.hubInstalled) {
      if (!current) {
        steps.push(
          planStep(
            "skill-install",
            skill.name,
            "unsupported",
            "This local skill is not installed and cannot be reconstructed from the snapshot.",
          ),
        );
      } else {
        steps.push(planStep("skill-install", skill.name, "skip", "Already installed locally."));
      }
      continue;
    }
    if (current) {
      steps.push(planStep("skill-install", skill.name, "skip", "Already installed from the hub."));
    } else {
      steps.push(
        planStep("skill-install", skill.name, "apply", "Install from the hub.", {
          kind: "skill-install",
          skill,
        }),
      );
    }
  }

  for (const install of snapshot.catalogInstalls) {
    if (installedCatalog.has(install.installName) || liveServers.has(install.installName)) {
      steps.push(planStep("catalog-install", install.installName, "skip", "Already installed."));
    } else if (!availableCatalog.has(install.installName)) {
      steps.push(
        planStep(
          "catalog-install",
          install.installName,
          "unsupported",
          "This catalog entry is not available in the current June runtime.",
        ),
      );
    } else {
      willCreateServers.add(install.installName);
      steps.push(
        planStep("catalog-install", install.installName, "apply", "Install from the catalog.", {
          kind: "catalog-install",
          install,
        }),
      );
    }
  }

  for (const server of snapshot.mcpServers.filter((entry) => !catalogNames.has(entry.name))) {
    const invalidReason = invalidServerDefinition(server);
    if (invalidReason) {
      invalidServers.add(server.name);
      steps.push(
        planStep(
          "mcp-add",
          server.name,
          "unsupported",
          `June did not add this malformed server definition. ${invalidReason}`,
        ),
      );
      continue;
    }
    const current = liveServers.get(server.name);
    if (!current) {
      willCreateServers.add(server.name);
      steps.push(
        planStep("mcp-add", server.name, "apply", "Add this server definition.", {
          kind: "mcp-add",
          server,
        }),
      );
      continue;
    }
    const differences = mcpServerDefinitionDifferences(server, current);
    if (differences.length === 0) {
      steps.push(
        planStep("mcp-add", server.name, "skip", "Already installed with the same definition."),
      );
    } else {
      conflictingServers.add(server.name);
      steps.push(
        planStep(
          "mcp-add",
          server.name,
          "unsupported",
          `A server with this name already exists but differs in ${differences.join(", ")}. June left its connection and secrets unchanged.`,
        ),
      );
    }
  }

  // Then apply enabled state to things that now exist.
  for (const skill of snapshot.skills) {
    const current = liveSkills.get(skill.name);
    if (current?.enabled === skill.enabled) {
      steps.push(planStep("skill-toggle", skill.name, "skip", "Enabled state already matches."));
    } else if (current || skill.hubInstalled) {
      steps.push(
        planStep(
          "skill-toggle",
          skill.name,
          "apply",
          skill.enabled ? "Enable this skill." : "Disable this skill.",
          { kind: "skill-toggle", skill },
        ),
      );
    } else {
      steps.push(
        planStep(
          "skill-toggle",
          skill.name,
          "unsupported",
          "The skill must be installed before its enabled state can be restored.",
        ),
      );
    }
  }

  for (const server of snapshot.mcpServers) {
    const current = liveServers.get(server.name);
    if (current?.enabled === server.enabled) {
      steps.push(planStep("mcp-toggle", server.name, "skip", "Enabled state already matches."));
    } else if (invalidServers.has(server.name)) {
      steps.push(
        planStep(
          "mcp-toggle",
          server.name,
          "unsupported",
          "June left the enabled state unchanged because the imported server definition is malformed.",
        ),
      );
    } else if (conflictingServers.has(server.name)) {
      steps.push(
        planStep(
          "mcp-toggle",
          server.name,
          "unsupported",
          "The existing server has a different connection definition, so June left its enabled state unchanged.",
        ),
      );
    } else if (current || willCreateServers.has(server.name)) {
      steps.push(
        planStep(
          "mcp-toggle",
          server.name,
          "apply",
          server.enabled ? "Enable this server." : "Disable this server.",
          { kind: "mcp-toggle", server },
        ),
      );
    } else {
      steps.push(
        planStep(
          "mcp-toggle",
          server.name,
          "unsupported",
          "The server must be installed before its enabled state can be restored.",
        ),
      );
    }
  }

  for (const toolset of snapshot.readiness.toolsets) {
    const current = liveToolsets.get(toolset.name);
    if (!current) {
      steps.push(
        planStep(
          "toolset-toggle",
          toolset.name,
          "unsupported",
          "This toolset is not available in the current June runtime.",
        ),
      );
    } else if (current.enabled === toolset.enabled) {
      steps.push(
        planStep("toolset-toggle", toolset.name, "skip", "Enabled state already matches."),
      );
    } else {
      steps.push(
        planStep(
          "toolset-toggle",
          toolset.name,
          "apply",
          toolset.enabled ? "Enable this toolset." : "Disable this toolset.",
          { kind: "toolset-toggle", toolset },
        ),
      );
    }
  }

  // Config changes are batched into one read-modify-write during apply.
  for (const server of snapshot.mcpServers) {
    const current = liveServers.get(server.name);
    const currentFilters = configuredToolFilters(live.config, current, server.name);
    const filtersMatch =
      current &&
      sameList(currentFilters.include, server.includeTools) &&
      sameList(currentFilters.exclude, server.excludeTools);
    if (invalidServers.has(server.name) && !filtersMatch) {
      steps.push(
        planStep(
          "tool-filter",
          server.name,
          "unsupported",
          "June left the tool filters unchanged because the imported server definition is malformed.",
        ),
      );
      continue;
    }
    if (conflictingServers.has(server.name) && !filtersMatch) {
      steps.push(
        planStep(
          "tool-filter",
          server.name,
          "unsupported",
          "The existing server has a different connection definition, so June left its tool filters unchanged.",
        ),
      );
      continue;
    }
    if (
      filtersMatch ||
      (!current && server.includeTools.length === 0 && server.excludeTools.length === 0)
    ) {
      steps.push(planStep("tool-filter", server.name, "skip", "Tool filters already match."));
      continue;
    }
    const write: ConfigSegmentWrite =
      server.includeTools.length === 0 && server.excludeTools.length === 0
        ? { op: "delete", segments: ["mcp_servers", server.name, "tools"] }
        : {
            op: "set",
            segments: ["mcp_servers", server.name, "tools"],
            value: {
              ...(server.includeTools.length > 0 ? { include: server.includeTools } : {}),
              ...(server.excludeTools.length > 0 ? { exclude: server.excludeTools } : {}),
            },
          };
    steps.push(
      planStep("tool-filter", server.name, "apply", "Restore the tool filter policy.", {
        kind: "config-write",
        write,
        restart: true,
      }),
    );
  }

  for (const entry of snapshot.skillConfig ?? []) {
    const segments = ["skills", "config", entry.skill, entry.key];
    const current = stringConfigValue(configValue(live.config, segments));
    const name = `${entry.skill}.${entry.key}`;
    if (current === entry.value) {
      steps.push(planStep("skill-config", name, "skip", "Config value already matches."));
    } else {
      steps.push(
        planStep("skill-config", name, "apply", "Restore this non-secret config value.", {
          kind: "config-write",
          write: { op: "set", segments, value: entry.value },
          restart: false,
        }),
      );
    }
  }

  const currentDirs = readExternalDirs(live.config);
  const importedDirs = (snapshot.externalDirs ?? []).map((entry) => entry.path);
  const mergedDirs = [...currentDirs];
  const addedDirs: string[] = [];
  for (const path of importedDirs) {
    if (!mergedDirs.includes(path)) {
      mergedDirs.push(path);
      addedDirs.push(path);
    }
  }
  if (importedDirs.length > 0) {
    if (mergedDirs.length === currentDirs.length) {
      steps.push(
        planStep(
          "external-dir",
          "External skill directories",
          "skip",
          "All paths are already configured.",
        ),
      );
    } else {
      steps.push(
        planStep(
          "external-dir",
          "External skill directories",
          "apply",
          `Add ${addedDirs.join(", ")} without removing current paths. These paths run outside the sandbox; review their contents before enabling their skills.`,
          {
            kind: "config-write",
            write: { op: "set", segments: ["skills", "external_dirs"], value: mergedDirs },
            restart: false,
          },
        ),
      );
    }
  }

  for (const bundle of snapshot.bundles ?? []) {
    steps.push(
      planStep(
        "bundle",
        bundle.skill,
        "unsupported",
        "This bundle reference is preserved in the snapshot but cannot be recreated automatically.",
      ),
    );
  }

  const secretOwners = new Set(
    steps
      .filter((step) => step.disposition === "apply")
      .flatMap((step) => {
        if (step.operation?.kind === "mcp-add") return [`mcp:${step.name}`];
        if (step.operation?.kind === "catalog-install") return [`catalog:${step.name}`];
        return [];
      }),
  );
  const requiredSecrets = snapshot.requiredInputs.filter((secret) =>
    secret.scope === "catalog-env"
      ? secretOwners.has(`catalog:${secret.owner}`)
      : secretOwners.has(`mcp:${secret.owner}`),
  );

  return {
    steps,
    requiredSecrets,
    changeCount: steps.filter((step) => step.disposition !== "skip").length,
  };
}

async function loadImportInventory(client: HermesAdminClient): Promise<ImportInventory> {
  const [skills, mcpServers, catalog, toolsets, config] = await Promise.all([
    client.skills.list(),
    client.mcp.listServers(),
    client.mcp.catalog().catch(() => []),
    client.toolsets.list().catch(() => []),
    client.config.get(),
  ]);
  return { skills, mcpServers, catalog, toolsets, config: config.config };
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  if (server.args.length > 0) payload.args = server.args;
  if (server.url) payload.url = server.url;
  if (server.auth && server.auth !== "none" && server.auth !== "unknown") {
    payload.auth = server.auth;
  }
  const env: Record<string, string> = {};
  for (const key of server.envKeys) {
    const value = secrets[`mcp-env:${server.name}:${key}`];
    if (value) env[key] = value;
  }
  if (Object.keys(env).length > 0) payload.env = env;
  const headers: Record<string, string> = {};
  for (const key of server.headerKeys) {
    const value = secrets[`mcp-header:${server.name}:${key}`];
    if (value) headers[key] = value;
  }
  if (Object.keys(headers).length > 0) payload.headers = headers;
  return payload;
}

/** Applies a freshly rebuilt inventory plan in safe order. */
export async function applySnapshot(
  client: HermesAdminClient,
  snapshot: SetupSnapshot,
  options: ApplyOptions = {},
): Promise<ImportReport> {
  const secrets = options.secrets ?? {};
  const steps: ImportStepResult[] = [];
  const plan = buildImportPlan(snapshot, await loadImportInventory(client));
  const configSteps: ImportPlanStep[] = [];
  const failedSkillInstalls = new Set<string>();
  const failedServerCreates = new Set<string>();
  let requiresRestart = false;

  const record = (step: ImportStepResult) => {
    steps.push(step);
    options.onStep?.(step);
  };

  for (const step of plan.steps) {
    if (step.disposition !== "apply") {
      record({
        category: step.category,
        name: step.name,
        status: step.disposition === "skip" ? "skipped" : "unsupported",
        detail: step.detail,
      });
      continue;
    }
    const operation = step.operation;
    if (!operation) continue;
    if (operation.kind === "config-write") {
      configSteps.push(step);
      continue;
    }
    if (operation.kind === "skill-toggle" && failedSkillInstalls.has(step.name)) {
      record({
        category: step.category,
        name: step.name,
        status: "skipped",
        detail: "The skill was not installed, so June left its enabled state unchanged.",
      });
      continue;
    }
    if (operation.kind === "mcp-toggle" && failedServerCreates.has(step.name)) {
      record({
        category: step.category,
        name: step.name,
        status: "skipped",
        detail: "The server was not created, so June left its enabled state unchanged.",
      });
      continue;
    }

    try {
      if (operation.kind === "skill-install") {
        const outcome = await client.skills.hubInstall(operation.skill.name);
        const status = await settleAction(client, outcome.action, options);
        if (status?.state === "failed") throw new Error(status.error ?? "The hub install failed.");
        requiresRestart ||= outcome.requiresRestart;
        record({ ...step, status: "applied", detail: "Installed from the hub." });
      } else if (operation.kind === "catalog-install") {
        const env: Record<string, string> = {};
        for (const key of operation.install.requiredEnvKeys) {
          const value = secrets[`catalog-env:${operation.install.installName}:${key}`];
          if (value) env[key] = value;
        }
        const outcome = await client.mcp.installCatalogEntry({
          name: operation.install.installName,
          enable: operation.install.enabled,
          ...(Object.keys(env).length > 0 ? { env } : {}),
        });
        const status = await settleAction(client, outcome.action, options);
        if (status?.state === "failed") {
          throw new Error(status.error ?? "The catalog install failed.");
        }
        requiresRestart ||= outcome.requiresRestart;
        record({ ...step, status: "applied", detail: "Installed from the catalog." });
      } else if (operation.kind === "mcp-add") {
        const outcome = await client.mcp.addServer(buildAddPayload(operation.server, secrets));
        requiresRestart ||= outcome.requiresRestart;
        const missing = [
          ...operation.server.envKeys
            .filter((key) => !secrets[`mcp-env:${operation.server.name}:${key}`])
            .map((key) => `environment ${key}`),
          ...operation.server.headerKeys
            .filter((key) => !secrets[`mcp-header:${operation.server.name}:${key}`])
            .map((key) => `header ${key}`),
        ];
        record({
          ...step,
          status: "applied",
          detail:
            missing.length > 0 ? `Added. Still needs values for ${missing.join(", ")}.` : "Added.",
        });
      } else if (operation.kind === "skill-toggle") {
        const outcome = await client.skills.toggle(operation.skill.name, operation.skill.enabled);
        requiresRestart ||= outcome.requiresRestart;
        record({
          ...step,
          status: outcome.result.ok ? "applied" : "failed",
          detail: outcome.result.ok
            ? operation.skill.enabled
              ? "Enabled."
              : "Disabled."
            : "The toggle did not apply.",
        });
      } else if (operation.kind === "mcp-toggle") {
        const outcome = await client.mcp.setEnabled(
          operation.server.name,
          operation.server.enabled,
        );
        requiresRestart ||= outcome.requiresRestart;
        record({
          ...step,
          status: outcome.result.ok ? "applied" : "failed",
          detail: outcome.result.ok
            ? operation.server.enabled
              ? "Enabled."
              : "Disabled."
            : "The toggle did not apply.",
        });
      } else if (operation.kind === "toolset-toggle") {
        const outcome = await client.toolsets.toggle(
          operation.toolset.name,
          operation.toolset.enabled,
        );
        requiresRestart ||= outcome.requiresRestart;
        record({
          ...step,
          status: outcome.result.ok ? "applied" : "failed",
          detail: outcome.result.ok
            ? operation.toolset.enabled
              ? "Enabled."
              : "Disabled."
            : "The toggle did not apply.",
        });
      }
    } catch (error) {
      if (operation.kind === "skill-install") {
        failedSkillInstalls.add(step.name);
      }
      if (operation.kind === "mcp-add" || operation.kind === "catalog-install") {
        failedServerCreates.add(step.name);
      }
      record({
        category: step.category,
        name: step.name,
        status: "failed",
        detail: errMessage(error),
      });
    }
  }

  const applicableConfigSteps = configSteps.filter((step) => {
    if (step.category !== "tool-filter" || !failedServerCreates.has(step.name)) return true;
    record({
      category: step.category,
      name: step.name,
      status: "failed",
      detail: "The server was not created, so June did not write its tool filters.",
    });
    return false;
  });

  if (applicableConfigSteps.length > 0) {
    try {
      const writes = applicableConfigSteps.map(
        (step) => (step.operation as Extract<PlannedOperation, { kind: "config-write" }>).write,
      );
      const outcome = await client.config.applyWritesAtSegments(writes);
      requiresRestart ||=
        outcome.requiresRestart ||
        applicableConfigSteps.some(
          (step) => (step.operation as Extract<PlannedOperation, { kind: "config-write" }>).restart,
        );
      for (const step of applicableConfigSteps) {
        record({
          category: step.category,
          name: step.name,
          status: "applied",
          detail: step.detail,
        });
      }
    } catch (error) {
      for (const step of applicableConfigSteps) {
        record({
          category: step.category,
          name: step.name,
          status: "failed",
          detail: errMessage(error),
        });
      }
    }
  }

  let restarted = false;
  let healthClient = client;
  if (requiresRestart) {
    if (!options.restartRuntime) {
      record({
        category: "gateway-restart",
        name: "Agent runtime",
        status: "unsupported",
        detail: "June could not restart the agent runtime through the native Bridge.",
      });
    } else {
      try {
        healthClient = await options.restartRuntime();
        restarted = true;
        record({
          category: "gateway-restart",
          name: "Agent runtime",
          status: "applied",
          detail: "Restarted through June to apply the imported changes.",
        });
      } catch (error) {
        record({
          category: "gateway-restart",
          name: "Agent runtime",
          status: "failed",
          detail: errMessage(error),
        });
      }
    }
  }

  let health: ImportReport["health"];
  try {
    const [status, servers] = await Promise.all([
      healthClient.gateway.status(),
      healthClient.mcp.listServers(),
    ]);
    health = {
      gatewayRunning: status.gatewayRunning,
      serverCount: servers.length,
      enabledServers: servers.filter((server) => server.enabled).length,
    };
    record({
      category: "health-check",
      name: "Agent runtime",
      status: "applied",
      detail: status.gatewayRunning
        ? `The agent runtime is running with ${health.enabledServers} of ${health.serverCount} servers enabled.`
        : "The agent runtime is not running. Start it to use the imported setup.",
    });
  } catch (error) {
    record({
      category: "health-check",
      name: "Agent runtime",
      status: "failed",
      detail: errMessage(error),
    });
  }

  return {
    steps,
    hadFailures: steps.some((step) => step.status === "failed" || step.status === "unsupported"),
    restarted,
    health,
  };
}
