/**
 * "When does this change actually take effect?" — the single most important
 * thing June must communicate about an admin mutation, and the source of a whole
 * class of perceived bugs when it is wrong (specs 02 and 21). A huge fraction of
 * confusion comes from changing a setting and expecting the LIVE agent to know
 * instantly when Hermes only applies it to the next session or after a gateway
 * restart.
 *
 * This module is the ONE place that maps each admin mutation to its application
 * timing and the user-facing copy for it. Every page reads from here so the
 * "applies next session / gateway restart required" language is identical across
 * Skills and MCP, per the spec's "all lifecycle copy is consistent" criterion.
 *
 * Copy follows June conventions: sentence case, no em/en-dashes.
 */

/** When a mutation takes effect.
 * - `immediate`: live and current sessions see it now.
 * - `next-session`: applies to NEW sessions; the current session is unaffected.
 * - `gateway-restart`: requires a Hermes gateway restart before it applies. */
export type ApplicationTiming =
  | "immediate"
  | "next-session"
  | "gateway-restart";

/** The admin mutations whose timing June states explicitly. */
export type AdminMutation =
  | "skill.toggle"
  | "skill.hubInstall"
  | "skill.hubUpdate"
  | "skill.hubUninstall"
  | "toolset.toggle"
  | "mcp.add"
  | "mcp.remove"
  | "mcp.setEnabled"
  | "mcp.test"
  | "mcp.installCatalog"
  | "env.set"
  | "env.delete"
  | "gateway.restart";

/**
 * Application timing per mutation, as documented by Hermes' apply semantics:
 *
 * - skill enable/disable and hub install/update/uninstall: NEXT SESSION (the
 *   skill index is read when a session starts).
 * - MCP add/remove/enable/disable and catalog install: GATEWAY RESTART (tool
 *   inventory is built at gateway start), unless upstream ever reports hot
 *   reload.
 * - MCP test: IMMEDIATE (it is a probe, it changes nothing durable).
 * - env writes: GATEWAY RESTART (the runtime reads env at process start).
 * - gateway restart itself: IMMEDIATE once the restart completes.
 */
const TIMING: Readonly<Record<AdminMutation, ApplicationTiming>> =
  Object.freeze({
    "skill.toggle": "next-session",
    "skill.hubInstall": "next-session",
    "skill.hubUpdate": "next-session",
    "skill.hubUninstall": "next-session",
    "toolset.toggle": "next-session",
    "mcp.add": "gateway-restart",
    "mcp.remove": "gateway-restart",
    "mcp.setEnabled": "gateway-restart",
    "mcp.test": "immediate",
    "mcp.installCatalog": "gateway-restart",
    "env.set": "gateway-restart",
    "env.delete": "gateway-restart",
    "gateway.restart": "immediate",
  });

/** The application timing for a mutation. */
export function timingForMutation(mutation: AdminMutation): ApplicationTiming {
  return TIMING[mutation];
}

/** True when the mutation needs a gateway restart before it applies. UI uses
 * this to decide whether to surface the restart banner. */
export function requiresGatewayRestart(mutation: AdminMutation): boolean {
  return TIMING[mutation] === "gateway-restart";
}

/** A short inline label for a timing, e.g. for a pill next to a control. */
export function timingLabel(timing: ApplicationTiming): string {
  switch (timing) {
    case "immediate":
      return "Applies now";
    case "next-session":
      return "Applies next session";
    case "gateway-restart":
      return "Restart required";
  }
}

/** A one-sentence durable notification for a mutation that succeeded, matching
 * the spec's example copy. `subject` names the thing changed (a skill name, an
 * MCP server name) so the message is concrete. */
export function mutationNotification(
  mutation: AdminMutation,
  subject: string,
): string {
  switch (mutation) {
    case "skill.toggle":
      return `Skill updated. New sessions can use it.`;
    case "skill.hubInstall":
      return `Installed ${subject}. New sessions can use it.`;
    case "skill.hubUpdate":
      return `Updated ${subject}. New sessions use the new version.`;
    case "skill.hubUninstall":
      return `Removed ${subject}. New sessions will not load it.`;
    case "toolset.toggle":
      return `Toolset updated. New sessions can use it.`;
    case "mcp.add":
    case "mcp.installCatalog":
      return `Installed ${subject}. Restart Hermes gateway to expose its tools.`;
    case "mcp.remove":
      return `Removed ${subject}. Restart Hermes gateway to drop its tools.`;
    case "mcp.setEnabled":
      return `Updated ${subject}. Restart Hermes gateway to apply it.`;
    case "mcp.test":
      return `Tested ${subject}.`;
    case "env.set":
      return `Saved ${subject}. Restart Hermes gateway to apply it.`;
    case "env.delete":
      return `Removed ${subject}. Restart Hermes gateway to apply it.`;
    case "gateway.restart":
      return `Gateway restarted. Tool inventory refreshed.`;
  }
}
