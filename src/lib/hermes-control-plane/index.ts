/**
 * Hermes control plane — the typed contract every Hermes-aware feature imports.
 *
 * It is the ONLY layer that turns raw Hermes JSON-RPC gateway frames into typed
 * June events and typed June commands. Transport (sockets, reconnects, the 4009
 * "session busy" code) stays in `../hermes-gateway.ts`; session-list
 * normalization stays in `../hermes-adapter.ts`. This module does neither — it
 * classifies the live event stream and wraps outbound methods.
 *
 * For consumers:
 *
 * ```ts
 * import {
 *   classifyHermesEvent,
 *   createHermesMethods,
 *   hermesModeFor,
 *   type JuneHermesEvent,
 *   type PendingHermesAction,
 * } from "../lib/hermes-control-plane";
 *
 * const event = classifyHermesEvent(rawGatewayEvent); // total; never undefined
 * switch (event.kind) {
 *   case "pending_action": // event.action: PendingHermesAction
 *   case "unsupported":     // unknown raw types land here, sanitized — not dropped
 *   // …every kind is handled; no default needed
 * }
 *
 * const methods = createHermesMethods(gatewayClient);
 * await methods.steerSession({ sessionId, text: "focus on tests" });
 * ```
 *
 * Contract guarantees:
 * - `classifyHermesEvent` returns exactly one {@link JuneHermesEvent} per frame.
 * - Unknown raw types → `{ kind: "unsupported", rawType, sanitizedPayload }`.
 * - Secret/sensitive payload fields are redacted before they reach any event or
 *   log; `secret.request` never carries the secret value.
 * - `HermesMode = "sandboxed" | "unrestricted"` is the canonical mode type.
 *
 * See `./README.md` for the full picture and how to add a new event.
 */

export * from "./events";
export * from "./event-classifier";
export * from "./methods";
export * from "./sanitize";
export * from "./raw-types";
export * from "./replay";
export * from "./compatibility";
export * from "./parse";
