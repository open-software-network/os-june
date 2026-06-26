/**
 * Hermes version compatibility matrix.
 *
 * A single, machine-readable, HONEST record of what June actually does with the
 * currently pinned Hermes runtime: which control-plane methods are wired into
 * UI, which classified events render, and which first-party feature surfaces
 * exist. It is the source of truth feature 20's upgrade checklist reads, and the
 * gate `isHermesFeatureSupported` consults.
 *
 * Honesty rules this matrix is held to (see the per-pack history in
 * `../README.md` and `docs/hermes-upstream-v2026.6.19.md`):
 * - `"supported"` means June BOTH understands the surface AND ships UI/flow that
 *   uses it today, with tests. Nothing aspirational.
 * - `"partial"` means the seam exists (e.g. the event is classified, or a
 *   generic settings surface exists) but the user-facing flow is incomplete.
 * - `"planned"` means feature 01 left a typed stub/classification but there is
 *   no UI at all yet; a later feature owns wiring it.
 * - `"unsupported"` means June deliberately does not handle it.
 * - `"unknown"` is reserved for queries about other versions or absent keys —
 *   the matrix entries themselves never use it.
 *
 * DOWNSTREAM FEATURES: when you ship your feature (add UI + tests that exercise
 * the method/event), flip your entry's `status` from `"planned"`/`"partial"` to
 * `"supported"` and update its `rationale` to point at the shipped surface. That
 * one-line change is all that is needed; keep the keys stable. The map of which
 * feature owns which keys is in `OWNERSHIP` below and in this module's tests.
 */

/** The pinned Hermes version this matrix describes. MUST equal the version in
 * `docs/hermes-upstream-v2026.6.19.md`. Bumping the Hermes pin REQUIRES updating
 * this constant and re-auditing every entry below (feature 20 checklist). */
export const PINNED_HERMES_VERSION = "v2026.6.19" as const;

/**
 * Support status for one matrix entry.
 * - `supported`: classified/handled AND wired into shipping UI/flow, with tests.
 * - `partial`: seam exists but the user-facing flow is incomplete.
 * - `planned`: typed stub or classification exists, no UI yet; a later feature
 *   owns it.
 * - `unsupported`: June deliberately does not handle this.
 * - `unknown`: only returned for unrecognized keys or non-pinned versions; never
 *   stored on an entry.
 */
export type HermesCompatibilityStatus =
  | "supported"
  | "partial"
  | "planned"
  | "unsupported"
  | "unknown";

/** A single tracked surface: its current status plus the rationale that makes
 * the status auditable. `since` records when the entry first appeared so a pin
 * bump can spot newly-added surfaces. */
export type HermesCompatibilityEntry = {
  status: HermesCompatibilityStatus;
  /** Why this status, in plain language. Sentence case, no dashes. */
  rationale: string;
  /** Hermes pin in which June started tracking this surface. */
  since: string;
};

/** A keyed group of entries (methods, events, or features). */
export type HermesCompatibilitySection = Record<
  string,
  HermesCompatibilityEntry
>;

/** The whole matrix for one Hermes pin. */
export type HermesCompatibilityMatrix = {
  hermesVersion: string;
  methods: HermesCompatibilitySection;
  events: HermesCompatibilitySection;
  features: HermesCompatibilitySection;
};

const PIN = PINNED_HERMES_VERSION;

/**
 * Control-plane methods. Feature 01 (`methods.ts`) provides typed STUBS for the
 * steer/branch/compress/usage/dispatch/sudo/secret/subagent/image surfaces; each
 * flips to `supported` as its owning feature ships UI + tests (see OWNERSHIP).
 * subagent.interrupt is `supported` (feature 13's drawer stop button) and
 * image.attach is `supported` (feature 19's composer image-attach flow). The
 * four baseline methods June already calls live (grep-confirmed in
 * `AgentWorkspace.tsx`) are `supported`.
 */
const methods: HermesCompatibilitySection = {
  // --- Baseline: June already calls these in the live session flow today. ---
  "session.create": {
    status: "supported",
    rationale:
      "AgentWorkspace creates every Hermes session via session.create; covered by the gateway tests.",
    since: PIN,
  },
  "prompt.submit": {
    status: "supported",
    rationale:
      "AgentWorkspace submits user turns via prompt.submit; the 4009 busy path is handled in the gateway.",
    since: PIN,
  },
  "session.interrupt": {
    status: "supported",
    rationale:
      "The stop control in AgentWorkspace sends session.interrupt to halt the active turn.",
    since: PIN,
  },
  "session.active_list": {
    status: "supported",
    rationale:
      "AgentWorkspace polls session.active_list as ground truth for what is actually running.",
    since: PIN,
  },

  // --- Feature 01 stubs: typed wrappers exist, no UI wiring yet. ---
  "session.steer": {
    status: "supported",
    rationale:
      "The busy-composer steer input in AgentWorkspace calls steerSession (session.steer) to redirect a still-working turn and records the instruction as a Steering transcript item; covered by hermes-session-steer tests.",
    since: PIN,
  },
  "session.branch": {
    status: "supported",
    rationale:
      "AgentWorkspace's per-message 'Branch from here' action calls branchSession (session.branch), parses the authoritative new session id via parseBranchSessionResult, opens the fork, and banners 'Branched from <title>'; covered by hermes-session-branch tests.",
    since: PIN,
  },
  "session.compress": {
    status: "supported",
    rationale:
      "AgentWorkspace's session menu opens a SessionCompactDialog that confirms, calls compressSession (session.compress), and reports a Context compacted result with token savings when returned; covered by hermes-session-compress tests.",
    since: PIN,
  },
  "session.usage": {
    status: "supported",
    rationale:
      "AgentWorkspace's session menu opens a SessionUsagePanel that calls getSessionUsage and renders normalized tokens, context, and estimated cost; covered by hermes-session-usage tests.",
    since: PIN,
  },
  "command.dispatch": {
    status: "supported",
    rationale:
      "The composer model picker switches a live session by dispatching /model via switchActiveSessionModel (command.dispatch) and only claims success on the gateway ack; covered by hermes-model-switch and agent-workspace tests.",
    since: PIN,
  },
  "subagent.interrupt": {
    status: "supported",
    rationale:
      "Feature 13 ships a per-subagent stop button on active rows in the Agent activity drawer that calls interruptSubagent (subagent.interrupt) with the row's trustworthy id/handle, confirms when the subagent is mid file/tool work, optimistically marks it stopping, and reconciles from the event stream (an already-complete interrupt settles quietly); covered by hermes-subagent-interrupt tests.",
    since: PIN,
  },
  "image.attach": {
    status: "supported",
    rationale:
      "Feature 19 wires the composer's imported images into image.attach (attachImage): on submit each pending image is read from the workspace and attached, the chip shows imported/attached/failed, a failed attach blocks the send, and the attachment lands in feature 14's artifact timeline; covered by hermes-image-attach and agent-workspace tests. The base64 is read on demand and never stored in React state or the trace.",
    since: PIN,
  },
  "sudo.respond": {
    status: "supported",
    rationale:
      "The inline sudo card in AgentWorkspace resolves privilege-escalation prompts via respondToSudo (sudo.respond); covered by hermes-sudo-secret-actions tests.",
    since: PIN,
  },
  "secret.respond": {
    status: "supported",
    rationale:
      "The inline secret card in AgentWorkspace submits the entered value via respondToSecret (secret.respond) and never retains it; covered by hermes-sudo-secret-actions tests.",
    since: PIN,
  },
};

/**
 * Event families classified by `event-classifier.ts`. message/thinking/tool
 * classify AND render today, so they are `supported`. approval/clarify classify
 * AND render through the existing chat cards (approval.respond/clarify.respond),
 * so they are `supported`. sudo/secret classify into pending_action AND render
 * through the inline sudo/secret cards (sudo.respond/secret.respond, feature
 * 03), so they are now `supported` too. subagent.* classifies into
 * background_activity but no drawer renders it yet, so it is `partial`.
 * error/lifecycle are handled.
 */
const events: HermesCompatibilitySection = {
  message: {
    status: "supported",
    rationale:
      "message.start/delta/complete classify to transcript events and render in the chat transcript.",
    since: PIN,
  },
  thinking: {
    status: "supported",
    rationale:
      "thinking.delta and reasoning.delta classify to reasoning events and render as reasoning parts.",
    since: PIN,
  },
  tool: {
    status: "supported",
    rationale:
      "tool.start/progress/complete classify to tool events and render as tool cards.",
    since: PIN,
  },
  approval: {
    status: "supported",
    rationale:
      "approval.request classifies to a pending_action and renders an approval card resolved via approval.respond.",
    since: PIN,
  },
  clarify: {
    status: "supported",
    rationale:
      "clarify.request classifies to a pending_action and renders a clarify card resolved via clarify.respond.",
    since: PIN,
  },
  sudo: {
    status: "supported",
    rationale:
      "sudo.request classifies into a redacted pending_action and renders an explicit approve/deny sudo card resolved via sudo.respond.",
    since: PIN,
  },
  secret: {
    status: "supported",
    rationale:
      "secret.request classifies with the value redacted and renders a secure secret-entry card resolved via secret.respond; the entered value is never persisted.",
    since: PIN,
  },
  subagent: {
    status: "supported",
    rationale:
      "subagent.* classifies into background_activity and now renders in feature 11's Agent activity drawer: the parent session enters a 'Background work' phase and shows a live subagent count, fed from hermesActivityStore; covered by hermes-activity-store and agent-activity-drawer tests. Feature 12 deepens this into per-subagent rows (the matrix key is shared; see OWNERSHIP).",
    since: PIN,
  },
  error: {
    status: "supported",
    rationale:
      "error frames classify to error events with a safe message and surface in the session.",
    since: PIN,
  },
  lifecycle: {
    status: "supported",
    rationale:
      "gateway.ready, session.info, and status/lifecycle frames classify to lifecycle events and drive session status.",
    since: PIN,
  },
};

/**
 * First-party feature surfaces tracked for the upgrade checklist. The upstream
 * runtime ships the capability (see docs/hermes-upstream-v2026.6.19.md), but
 * June must build the product surface before users can rely on it. These reflect
 * June's UI, not Hermes' capability.
 */
const features: HermesCompatibilitySection = {
  backgroundSubagentWatch: {
    status: "supported",
    rationale:
      "Feature 12 ships per-subagent watch in the Agent activity drawer: subagent.* normalizes into hermesActivityStore's subagents[] (one record each, UPSERTED by subagentId/handle across start/progress/tool/thinking/complete/error/blocked) and renders as a 'Background work' sub-list under the parent session showing each subagent's task, status, current tool, last-event time, and completion summary; covered by hermes-subagent-watch and agent-activity-drawer tests.",
    since: PIN,
  },
  imageEditing: {
    status: "partial",
    rationale:
      "Feature 19 ships explicit source-image selection: imported images attach to the session via image.attach (so an edit prompt names a concrete image instead of relying on a path in prose), with imported/attached/failed status and the attachment in the artifact timeline. June does not yet render the edited image_generate OUTPUT back inline, so this stays partial rather than supported; covered by hermes-image-attach and agent-workspace tests.",
    since: PIN,
  },
  automationBlueprints: {
    status: "planned",
    rationale:
      "Upstream adds guided Automation Blueprints, but June still routes routines through its own editor and has not integrated blueprints. Decision pending.",
    since: PIN,
  },
  messagingIntegrations: {
    status: "partial",
    rationale:
      "June lists and toggles messaging platforms in settings, but the new upstream platforms (Photon iMessage, WhatsApp Cloud, Raft) have no setup UI yet.",
    since: PIN,
  },
};

/**
 * The compatibility matrix for the currently pinned Hermes runtime. Frozen so a
 * consumer cannot accidentally mutate shared state; flips happen by editing the
 * source above, not at runtime.
 */
export const hermesCompatibilityMatrix: HermesCompatibilityMatrix =
  Object.freeze({
    hermesVersion: PIN,
    methods: Object.freeze(methods) as HermesCompatibilitySection,
    events: Object.freeze(events) as HermesCompatibilitySection,
    features: Object.freeze(features) as HermesCompatibilitySection,
  });

/**
 * Which downstream feature must flip which matrix keys to `supported` once it
 * ships UI + tests. Kept as data (not just prose) so the relationship is
 * greppable and testable. Feature numbers match the pack plan.
 */
export const OWNERSHIP: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "03": [
      "events.sudo",
      "events.secret",
      "methods.sudo.respond",
      "methods.secret.respond",
    ],
    "06": ["methods.session.steer"],
    "07": ["methods.session.branch"],
    "08": ["methods.session.compress"],
    "09": ["methods.session.usage"],
    "10": ["methods.command.dispatch"],
    "11": ["events.subagent"],
    "12": ["events.subagent", "features.backgroundSubagentWatch"],
    "13": ["methods.subagent.interrupt"],
    "19": ["methods.image.attach", "features.imageEditing"],
  });
