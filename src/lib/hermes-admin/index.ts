/**
 * Hermes admin — the typed, profile/mode-aware REST client and state lifecycle
 * every June-native admin surface imports. It is the admin analogue of
 * `../hermes-control-plane` (which owns the live JSON-RPC event/command stream);
 * this module owns the dashboard REST surface: Skills, Toolsets, Skills Hub, MCP
 * servers, MCP catalog, gateway lifecycle, env writes, background action status,
 * and diagnostics.
 *
 * The four layers, all reached through this barrel:
 *
 * 1. CLIENT (`client` + `transport` + `schemas` + `errors` + `redact`): one
 *    typed client per explicit {@link HermesAdminTarget}. Profile/mode targeting
 *    is explicit — there is no implicit "first connection" fallback for any
 *    write. Secrets are redacted before any log or error.
 * 2. TIMING (`application-timing`): the one map of each mutation to "applies now
 *    / next session / restart required", with consistent copy.
 * 3. CACHE (`cache`): profile-scoped resource keys + the mutation→invalidation
 *    rules + durable notifications. A profile switch cannot surface stale data.
 * 4. LIFECYCLE (`gateway-lifecycle`): the restart/reindex state machine + a
 *    restart driver that polls the action and refreshes the inventory, never
 *    interrupting a live session without confirmation.
 *
 * Typical use:
 *
 * ```ts
 * import {
 *   adminTargetForCurrentMode,
 *   createHermesAdminClient,
 *   AdminStateCache,
 *   GatewayLifecycle,
 * } from "../lib/hermes-admin";
 *
 * const target = adminTargetForCurrentMode(bridgeStatus, "sandboxed");
 * if (!target) return; // that mode is not running — do not guess another
 * const admin = createHermesAdminClient(target);
 * const cache = new AdminStateCache(target);
 * const lifecycle = new GatewayLifecycle(admin, cache);
 *
 * const { mutation } = await admin.mcp.addServer({ name, url });
 * cache.afterMutation(mutation, name); // invalidates mcpServers + toolsets
 * lifecycle.noteMutation(mutation);    // banner: restart required
 * ```
 */

export * from "./target";
export * from "./errors";
export * from "./redact";
export * from "./schemas";
export * from "./application-timing";
export * from "./transport";
export * from "./rust-transport";
export * from "./client";
export * from "./cache";
export * from "./gateway-lifecycle";
export * from "./installed-skills-view";
export * from "./use-installed-skills";
export * from "./skill-setup-view";
export * from "./use-skill-setup";
export * from "./skill-detail-view";
export * from "./use-skill-detail";
export * from "./skill-lifecycle-view";
export * from "./use-skill-lifecycle";
export * from "./mcp-servers-view";
export * from "./use-mcp-servers";
export * from "./mcp-oauth-view";
export * from "./use-mcp-oauth";
export * from "./mcp-diagnostics-view";
export * from "./use-mcp-diagnostics";
export * from "./mcp-filtering-view";
export * from "./use-mcp-filtering";
export * from "./mcp-security-view";
export * from "./use-mcp-security";
export * from "./mcp-catalog-view";
export * from "./use-mcp-catalog";
export * from "./hub-search-view";
export * from "./skill-install-review";
export * from "./use-skills-hub";
export * from "./toolsets-view";
export * from "./use-toolsets";
export * from "./skill-review-view";
export * from "./use-skill-review";
export * from "./profile-builder-view";
export * from "./use-profile-builder";
export * from "./setup-snapshot";
export * from "./setup-import";
export * from "./use-setup-snapshot";
export * from "./external-dirs-view";
export * from "./use-external-dirs";
export * from "./skill-bundles-view";
export * from "./use-skill-bundles";
export * from "./integrations-health-view";
export * from "./use-integrations-health";
export * from "./taps-view";
export * from "./use-skill-taps";
