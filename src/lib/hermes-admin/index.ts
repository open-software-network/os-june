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
export * from "./client";
export * from "./cache";
export * from "./gateway-lifecycle";
export * from "./installed-skills-view";
export * from "./use-installed-skills";
