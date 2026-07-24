/**
 * The data hook behind June's setup import/export surface (spec 23). It does NOT
 * own a second client or cache: it reuses the spec-14 servers engine (one
 * target, one client, one cache, one lifecycle) and reads every other admin
 * surface (skills, catalog, toolsets, profiles, gateway status) through that
 * SAME client, so profile/mode targeting stays explicit and a change made on
 * another surface is consistent here.
 *
 * Two flows:
 *
 * - EXPORT: read the live surfaces, build a sanitized {@link SetupSnapshot} via
 *   {@link buildSetupSnapshot} (secrets redacted to key names, the whole
 *   document run through the structural redactor), and hand back a serialized
 *   blob to download.
 * - IMPORT: preview a pasted/opened snapshot ({@link parseSetupSnapshot}), diff
 *   it against the live setup ({@link diffSnapshot}), collect the missing
 *   secrets the user supplies, then apply in safe order via
 *   {@link applySnapshot}, restart the runtime through June's native Bridge, and
 *   report partial failures.
 *
 * Secrets are never read out of June into the export and never imported from a
 * file. Copy is sentence case, no em/en-dashes.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { GatewayLifecycleSnapshot } from "./gateway-lifecycle";
import type {
  HermesMcpCatalogEntry,
  HermesMcpServerInfo,
  HermesProfileSummary,
  HermesSkillInfo,
  HermesToolsetInfo,
} from "./schemas";
import { readExternalDirs } from "./schemas";
import type { HermesAdminMode } from "./target";
import type { McpServersEngine } from "./use-mcp-servers";
import {
  buildSetupSnapshot,
  diffSnapshot,
  parseSetupSnapshot,
  serializeSetupSnapshot,
  setupSnapshotFilename,
  type SetupSnapshot,
  type SnapshotCapabilities,
  type SnapshotDiff,
} from "./setup-snapshot";
import {
  applySnapshot,
  buildImportPlan,
  type ApplyOptions,
  type ImportPlan,
  type ImportReport,
} from "./setup-import";

/** A loaded export bundle: the snapshot, its serialized text, and a filename. */
export type ExportBundle = {
  snapshot: SetupSnapshot;
  text: string;
  filename: string;
};

/** The phase of the import preview/apply flow. */
export type ImportPhase = "idle" | "previewing" | "previewed" | "applying" | "applied" | "error";

/** Everything the setup snapshot component renders, plus the actions it calls. */
export type SetupSnapshotState = {
  status: "unavailable" | "loading" | "ready" | "error";
  mode?: HermesAdminMode;
  profile?: string;
  error?: string;
  retryable: boolean;
  lifecycle: GatewayLifecycleSnapshot;
  /** Whether the live surfaces have loaded enough to export. */
  canExport: boolean;
  /** Whether the user opted into capturing non-secret skill config. */
  includeSkillConfig: boolean;
  setIncludeSkillConfig: (include: boolean) => void;
  refresh: () => void;
  /** Builds the sanitized export bundle for the current live state. */
  buildExport: (now?: Date) => ExportBundle;
  // import flow
  importPhase: ImportPhase;
  /** The parsed snapshot from a preview, when one succeeded. */
  previewSnapshot?: SetupSnapshot;
  /** The diff of the preview against the live setup. */
  previewDiff?: SnapshotDiff;
  /** The exact inventory-derived operations apply will revalidate and run. */
  previewPlan?: ImportPlan;
  importError?: string;
  /** The applied report, when an apply completed. */
  report?: ImportReport;
  /** Parses + diffs a pasted/opened snapshot for the preview step. */
  preview: (raw: string) => void;
  /** Applies the previewed snapshot with the supplied secrets. */
  apply: (secrets: Record<string, string>) => Promise<void>;
  /** Clears the import flow back to idle. */
  resetImport: () => void;
};

const CLEAN_LIFECYCLE: GatewayLifecycleSnapshot = {
  state: "clean",
  label: "Up to date",
  detail: "No pending changes.",
  canRestart: false,
};

/** The frozen state shown when there is no runtime to talk to. */
const UNAVAILABLE_STATE: SetupSnapshotState = Object.freeze({
  status: "unavailable",
  retryable: false,
  lifecycle: CLEAN_LIFECYCLE,
  canExport: false,
  includeSkillConfig: false,
  setIncludeSkillConfig: () => {},
  refresh: () => {},
  buildExport: () => ({
    snapshot: {
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      profile: "default",
      mode: "sandboxed",
      notes: [],
      profiles: [],
      skills: [],
      mcpServers: [],
      catalogInstalls: [],
      toolFilters: [],
      requiredInputs: [],
      readiness: { toolsets: [] },
    },
    text: "{}",
    filename: "june-setup.json",
  }),
  importPhase: "idle",
  preview: () => {},
  apply: () => Promise.resolve(),
  resetImport: () => {},
}) as SetupSnapshotState;

type LiveData = {
  profiles: HermesProfileSummary[];
  skills: HermesSkillInfo[];
  mcpServers: HermesMcpServerInfo[];
  catalog: HermesMcpCatalogEntry[];
  toolsets: HermesToolsetInfo[];
  gatewayRunning?: boolean;
  gatewayVersion?: string;
  config: Record<string, unknown>;
};

function skillConfigFrom(config: Record<string, unknown>): Record<string, Record<string, string>> {
  const skills = config.skills;
  if (!skills || typeof skills !== "object" || Array.isArray(skills)) return {};
  const values = (skills as Record<string, unknown>).config;
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [skill, rawEntries] of Object.entries(values as Record<string, unknown>)) {
    if (!rawEntries || typeof rawEntries !== "object" || Array.isArray(rawEntries)) continue;
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
      if (typeof value === "string") entries[key] = value;
    }
    if (Object.keys(entries).length > 0) out[skill] = entries;
  }
  return out;
}

/**
 * Binds the snapshot flows to the shared servers engine for one target. A null
 * engine yields the "unavailable" state. The component calls
 * {@link useSetupSnapshot}; tests call this with a harness-built engine so they
 * need no Tauri mock. `applyOptions` is injected by tests so poll loops run
 * without real timers.
 */
export function useSetupSnapshotController(
  engine: McpServersEngine | null,
  applyOptions: Partial<ApplyOptions> = {},
): SetupSnapshotState {
  const [status, setStatus] = useState<SetupSnapshotState["status"]>(
    engine ? "loading" : "unavailable",
  );
  const [error, setError] = useState<string>();
  const [retryable, setRetryable] = useState(false);
  const [live, setLive] = useState<LiveData>();
  const [includeSkillConfig, setIncludeSkillConfig] = useState(false);
  const [lifecycle, setLifecycle] = useState<GatewayLifecycleSnapshot>(
    engine ? engine.lifecycle.getSnapshot() : CLEAN_LIFECYCLE,
  );

  const [importPhase, setImportPhase] = useState<ImportPhase>("idle");
  const [previewSnapshot, setPreviewSnapshot] = useState<SetupSnapshot>();
  const [previewDiff, setPreviewDiff] = useState<SnapshotDiff>();
  const [previewPlan, setPreviewPlan] = useState<ImportPlan>();
  const [importError, setImportError] = useState<string>();
  const [report, setReport] = useState<ImportReport>();

  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    if (!engine) return;
    return engine.lifecycle.subscribe(setLifecycle);
  }, [engine]);

  useEffect(() => {
    if (!engine) {
      setStatus("unavailable");
      return;
    }
    let cancelled = false;
    setStatus((prev) => (reloadVersion > 0 || prev !== "ready" ? "loading" : "ready"));
    const { client } = engine;
    Promise.all([
      client.profiles.list().catch(() => [] as HermesProfileSummary[]),
      client.skills.list(),
      client.mcp.listServers(),
      client.mcp.catalog().catch(() => [] as HermesMcpCatalogEntry[]),
      client.toolsets.list().catch(() => [] as HermesToolsetInfo[]),
      client.gateway.status().catch(() => undefined),
      client.config.get(),
    ])
      .then(([profiles, skills, mcpServers, catalog, toolsets, gateway, config]) => {
        if (cancelled) return;
        setLive({
          profiles,
          skills,
          mcpServers,
          catalog,
          toolsets,
          gatewayRunning: gateway?.gatewayRunning,
          gatewayVersion: gateway?.version,
          config: config.config,
        });
        setStatus("ready");
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setRetryable(true);
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [engine, reloadVersion]);

  const refresh = useCallback(() => {
    setReloadVersion((version) => version + 1);
  }, []);

  const buildExport = useCallback(
    (now?: Date): ExportBundle => {
      const target = engine?.target;
      const profile = target?.profile ?? "default";
      const mode = target?.mode ?? "sandboxed";
      const capabilities: SnapshotCapabilities | undefined = live
        ? { externalDirs: readExternalDirs(live.config).map((path) => ({ path })) }
        : undefined;
      const snapshot = buildSetupSnapshot({
        profile,
        mode,
        hermesVersion: live?.gatewayVersion,
        profiles: live?.profiles ?? [],
        skills: live?.skills ?? [],
        mcpServers: live?.mcpServers ?? [],
        catalog: live?.catalog ?? [],
        toolsets: live?.toolsets ?? [],
        gatewayRunning: live?.gatewayRunning,
        gatewayVersion: live?.gatewayVersion,
        includeSkillConfig,
        skillConfig: live ? skillConfigFrom(live.config) : undefined,
        capabilities,
        now,
      });
      return {
        snapshot,
        text: serializeSetupSnapshot(snapshot),
        filename: setupSnapshotFilename(profile, now),
      };
    },
    [engine, live, includeSkillConfig],
  );

  const preview = useCallback(
    (raw: string) => {
      setImportPhase("previewing");
      setImportError(undefined);
      setReport(undefined);
      const parsed = parseSetupSnapshot(raw);
      if (!parsed.ok) {
        setImportError(parsed.error);
        setImportPhase("error");
        setPreviewSnapshot(undefined);
        setPreviewDiff(undefined);
        setPreviewPlan(undefined);
        return;
      }
      const plan = buildImportPlan(parsed.snapshot, {
        skills: live?.skills ?? [],
        mcpServers: live?.mcpServers ?? [],
        catalog: live?.catalog ?? [],
        toolsets: live?.toolsets ?? [],
        config: live?.config ?? {},
      });
      const diff = diffSnapshot(parsed.snapshot, {
        skills: live?.skills ?? [],
        mcpServers: live?.mcpServers ?? [],
        catalog: live?.catalog ?? [],
      });
      diff.requiredSecrets = plan.requiredSecrets;
      diff.changeCount = plan.changeCount;
      setPreviewSnapshot(parsed.snapshot);
      setPreviewDiff(diff);
      setPreviewPlan(plan);
      setImportPhase("previewed");
    },
    [live],
  );

  const apply = useCallback(
    async (secrets: Record<string, string>) => {
      if (!engine || !previewSnapshot) return;
      setImportPhase("applying");
      setImportError(undefined);
      try {
        const result = await applySnapshot(engine.client, previewSnapshot, {
          ...applyOptions,
          secrets,
        });
        setReport(result);
        setImportPhase("applied");
        // Refresh the live data so a subsequent export reflects the import.
        refresh();
      } catch (err: unknown) {
        setImportError(err instanceof Error ? err.message : String(err));
        setImportPhase("error");
      }
    },
    [engine, previewSnapshot, applyOptions, refresh],
  );

  const resetImport = useCallback(() => {
    setImportPhase("idle");
    setPreviewSnapshot(undefined);
    setPreviewDiff(undefined);
    setPreviewPlan(undefined);
    setImportError(undefined);
    setReport(undefined);
  }, []);

  const value = useMemo<SetupSnapshotState>(() => {
    if (!engine) return UNAVAILABLE_STATE;
    return {
      status,
      mode: engine.target.mode,
      profile: engine.target.profile,
      error,
      retryable,
      lifecycle,
      canExport: status === "ready" && live !== undefined,
      includeSkillConfig,
      setIncludeSkillConfig,
      refresh,
      buildExport,
      importPhase,
      previewSnapshot,
      previewDiff,
      previewPlan,
      importError,
      report,
      preview,
      apply,
      resetImport,
    };
  }, [
    engine,
    status,
    error,
    retryable,
    lifecycle,
    live,
    includeSkillConfig,
    refresh,
    buildExport,
    importPhase,
    previewSnapshot,
    previewDiff,
    previewPlan,
    importError,
    report,
    preview,
    apply,
    resetImport,
  ]);

  return value;
}
