/**
 * The data hook behind the Unified Integrations Health dashboard (admin surfaces
 * spec 22). This surface is a pure AGGREGATOR: it does not own a Hermes client,
 * a cache, or a mutation. It composes the landed admin hooks
 * ({@link useInstalledSkills}, {@link useToolsets}, {@link useMcpServers},
 * {@link useMcpDiagnostics}, {@link useSkillReview}, {@link useExternalDirs},
 * {@link useSkillsSetupOverview}) for ONE explicit mode + profile, reads the
 * selected generation model from June's provider settings, and reduces all of it
 * through the pure {@link buildIntegrationsHealth} reducer.
 *
 * It NEVER mutates a server, skill, secret, config, or directory. It reads the
 * same target every sub-hook reads, so the dashboard stays consistent with the
 * pages it links to. Secrets are surfaced as counts only; nothing here reads a
 * secret value.
 *
 * Split from the React component so the composition is exercised by the
 * component test through {@link IntegrationsHealthView} with a stubbed state,
 * and the reduction logic is exercised directly against
 * {@link buildIntegrationsHealth}.
 */

import { useEffect, useMemo, useState } from "react";
import {
  listVeniceModels,
  providerModelSettings,
  type VeniceModelDto,
} from "../tauri";
import { modelSupportsTools } from "../model-privacy";
import { useInstalledSkills } from "./use-installed-skills";
import { useToolsets } from "./use-toolsets";
import { useMcpServers } from "./use-mcp-servers";
import { useMcpDiagnostics } from "./use-mcp-diagnostics";
import { useSkillReview } from "./use-skill-review";
import { useExternalDirs } from "./use-external-dirs";
import { useSkillsSetupOverview } from "./use-skill-setup";
import { redactedEnv, redactedHeaders } from "./mcp-servers-view";
import { diagnoseServer } from "./mcp-diagnostics-view";
import {
  buildIntegrationsHealth,
  type IntegrationsHealth,
  type ModelHealthInput,
  type SkillHealthInput,
} from "./integrations-health-view";
import type { HermesAdminMode } from "./target";

/** Loads the selected generation model and its tool-calling capability. Returns
 * undefined until it has resolved, so the dashboard marks model readiness
 * unknown rather than guessing. */
function useSelectedModel(): ModelHealthInput | undefined {
  const [model, setModel] = useState<ModelHealthInput>();

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const settings = await providerModelSettings();
        const id = settings.settings.generationModel;
        if (cancelled) return;
        if (!id) {
          setModel({ id: "", supportsTools: undefined });
          return;
        }
        // The catalog read is best-effort: a failure leaves capability unknown
        // (a tool-incapable model is a hard blocker, so June will not falsely
        // mark it broken without evidence).
        let match: VeniceModelDto | undefined;
        try {
          const response = await listVeniceModels("generation");
          match = response.models.find((entry) => entry.id === id);
        } catch {
          match = undefined;
        }
        if (cancelled) return;
        setModel({
          id,
          name: match?.name ?? id,
          supportsTools: match ? modelSupportsTools(match) : undefined,
        });
      } catch {
        if (!cancelled) setModel(undefined);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  return model;
}

/**
 * The all-in-one production hook: composes every landed admin hook for one mode
 * + profile, reads the selected model, and reduces to the health model. The
 * component calls THIS; tests prefer {@link buildIntegrationsHealth} with crafted
 * inputs or {@link IntegrationsHealthView} with a stubbed state.
 */
export function useIntegrationsHealth(
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
): IntegrationsHealth {
  const installedSkills = useInstalledSkills(mode, profile);
  const toolsets = useToolsets(mode, profile);
  const mcpServers = useMcpServers(mode, profile);
  const diagnostics = useMcpDiagnostics(mode, profile);
  const review = useSkillReview(mode, profile);
  const externalDirs = useExternalDirs(mode, profile);
  const setupOverview = useSkillsSetupOverview(mode, profile);
  const model = useSelectedModel();

  // The dashboard is unavailable only when EVERY admin surface reports no
  // runtime. A single page being unavailable should not blank the others.
  const unavailable =
    installedSkills.status === "unavailable" &&
    toolsets.status === "unavailable" &&
    mcpServers.status === "unavailable" &&
    review.status === "unavailable" &&
    externalDirs.status === "unavailable";

  const skills: SkillHealthInput[] = useMemo(
    () =>
      installedSkills.skills.map((skill) => ({
        name: skill.name,
        enabled: skill.enabled,
        badge: setupOverview.badgeFor(skill),
      })),
    [installedSkills.skills, setupOverview],
  );

  // Secrets COUNTS only (never values). Configured = the env + header key names
  // across MCP servers (the redacted helpers return names, no values). Missing =
  // the MCP missing-config keys plus enabled skills whose badge says a secret is
  // missing. Both are pure counts.
  const secrets = useMemo(() => {
    let configured = 0;
    let missing = 0;
    for (const server of mcpServers.servers) {
      configured += redactedEnv(server).length + redactedHeaders(server).length;
      const diag = diagnoseServer(server);
      missing += diag.missingEnv.length + diag.missingHeaders.length;
    }
    for (const skill of skills) {
      if (skill.enabled && skill.badge?.status === "missing-api-key") {
        missing += 1;
      }
    }
    return { configured, missing };
  }, [mcpServers.servers, skills]);

  return useMemo(
    () =>
      buildIntegrationsHealth({
        mode,
        profile: mcpServers.profile ?? installedSkills.profile ?? profile,
        unavailable,
        model,
        lifecycle: diagnostics.lifecycle,
        skills,
        toolsets: toolsets.toolsets,
        mcpServers: mcpServers.servers,
        pendingSkillWrites: review.writes.length,
        externalDirs: externalDirs.rows,
        secrets,
        // High-risk MCP signal (spec 19) is not in this branch; omitted so the
        // dashboard degrades gracefully until that surface lands.
      }),
    [
      mode,
      profile,
      unavailable,
      model,
      diagnostics.lifecycle,
      skills,
      toolsets.toolsets,
      mcpServers.servers,
      mcpServers.profile,
      installedSkills.profile,
      review.writes.length,
      externalDirs.rows,
      secrets,
    ],
  );
}
