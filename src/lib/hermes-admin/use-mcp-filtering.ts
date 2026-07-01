/**
 * The data hook behind June's per-server MCP tool selection + filtering surface
 * (spec 16). Like the diagnostics surface, it does NOT own a second load
 * lifecycle: it reuses the spec-14 {@link McpServersController} (one engine, one
 * client, one cache, one lifecycle) for the server list, the per-server test
 * probes (test-time tool discovery), and the cache/lifecycle invalidation bus,
 * and layers the policy SAVE on top:
 *
 * - the tool policy is written through `client.config.setValue` at the SCOPED
 *   dotted path `mcp_servers.<name>.tools`, so the jailed dashboard owns the
 *   `config.yaml` write (no June-side EPERM) and only that block is touched —
 *   every unrelated server field and unrelated config is preserved;
 * - on success the cache/lifecycle are advanced with the `mcp.setTools` mutation
 *   (gateway-restart timing), which raises the spec's exact notification
 *   ("Tool filter saved. Restart Hermes gateway to refresh registered tools.")
 *   and flips the restart-required banner, then refreshes the list.
 *
 * Profile targeting stays explicit (the engine is built from one target), so a
 * write can only ever hit the runtime that target names. Split from the React
 * component so the save / preserve-unrelated-fields behavior is unit-testable
 * against the fake Hermes server with no rendering.
 */

import { useCallback, useState } from "react";
import { HermesAdminError } from "./errors";
import { toolsConfigPath, buildToolPolicyBlock } from "./mcp-filtering-view";
import type { ToolPolicyDraft } from "./mcp-filtering-view";
import {
  useMcpServersController,
  type McpServersEngine,
  type McpServersState,
} from "./use-mcp-servers";

/** The outcome of a policy save: `true` when the write landed, otherwise the
 * caller reads {@link McpFilteringState.saveError} for the safe message. */
export type SaveToolPolicyResult = boolean;

/** Everything the tool-filtering component needs on top of the shared servers
 * state: the save action and its in-flight / error state. */
export type McpFilteringState = McpServersState & {
  /** The server name whose policy save is in flight, or undefined. */
  savingServer?: string;
  /** The safe message from the last failed save, or undefined. */
  saveError?: string;
  /**
   * Persists a server's tool policy by writing ONLY the scoped
   * `mcp_servers.<name>.tools` block through the REST config path. Resolves true
   * on success (and refreshes the list), false on failure (with `saveError`
   * set). Preserves every unrelated server field and unrelated config.
   */
  saveToolPolicy: (
    serverName: string,
    draft: ToolPolicyDraft,
  ) => Promise<SaveToolPolicyResult>;
};

/**
 * Binds the tool-filtering save to the shared servers controller for one engine.
 * A null engine yields the shared "unavailable" state with a no-op save. The
 * component calls {@link useMcpFiltering}; tests call this with a harness-built
 * engine so they need no Tauri mock.
 */
export function useMcpFilteringController(
  engine: McpServersEngine | null,
): McpFilteringState {
  const servers = useMcpServersController(engine);
  const [savingServer, setSavingServer] = useState<string>();
  const [saveError, setSaveError] = useState<string>();

  const saveToolPolicy = useCallback(
    async (
      serverName: string,
      draft: ToolPolicyDraft,
    ): Promise<SaveToolPolicyResult> => {
      if (!engine) return false;
      setSavingServer(serverName);
      setSaveError(undefined);
      try {
        const block = buildToolPolicyBlock(draft);
        // Scoped write: setValue targets the dotted `mcp_servers.<name>.tools`
        // path, so the jailed dashboard merges ONLY that block into config.yaml
        // and leaves the server's command/url/env/headers and all other config
        // untouched.
        await engine.client.config.setValueAtSegments(
          toolsConfigPath(serverName),
          block,
        );
        // The write is `config.set` on the wire, but the FILTER only takes
        // effect after a gateway restart (Hermes builds the tool inventory at
        // gateway start), so June advances the cache/lifecycle with the
        // gateway-restart `mcp.setTools` mutation, which raises the spec's exact
        // "Tool filter saved. Restart Hermes gateway..." notice and flips the
        // restart-required banner.
        engine.cache.afterMutation("mcp.setTools", serverName);
        engine.lifecycle.noteMutation("mcp.setTools");
        setSavingServer(undefined);
        // Refresh so the row reflects the new include/exclude policy.
        servers.refresh();
        return true;
      } catch (error) {
        const adminError = HermesAdminError.from("PUT /api/config", error);
        setSaveError(adminError.safeMessage);
        setSavingServer(undefined);
        return false;
      }
    },
    [engine, servers],
  );

  return { ...servers, savingServer, saveError, saveToolPolicy };
}

/**
 * The all-in-one production hook: reuse the servers engine for the given
 * mode/profile (explicit targeting, no first-connection fallback) and run the
 * filtering controller. The page typically uses the servers hook directly and
 * drives the save from THIS slice; tests prefer
 * {@link useMcpFilteringController} with a harness engine.
 */
export function useMcpFiltering(engine: McpServersEngine | null) {
  return useMcpFilteringController(engine);
}
