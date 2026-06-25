/**
 * Raw wire shapes for the Hermes JSON-RPC gateway, kept deliberately defensive:
 * every field is optional and widely typed because these come straight off the
 * socket and a Hermes upgrade can add, rename, or drop fields at any time. The
 * classifier (see `event-classifier.ts`) is the only thing that reads these and
 * turns them into the typed {@link import("./events").JuneHermesEvent} union the
 * rest of the app consumes — never read raw payloads outside this module.
 *
 * These types describe a SUPERSET of what June emits today: Hermes documents a
 * broader surface (sudo/secret prompts, lifecycle, subagent error/blocked,
 * image attach) that downstream features depend on even though June does not
 * trigger every path yet.
 */

/** A JSON-RPC 2.0 frame as the gateway sends it. The transport in
 * `hermes-gateway.ts` already splits responses from event notifications; this
 * is here so trace/debug consumers can model a full frame. */
export type RawJsonRpcFrame = {
  jsonrpc?: "2.0" | string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RawJsonRpcError;
};

export type RawJsonRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

/** Every raw Hermes event/method name the pack needs to reason about. This is a
 * superset of `HermesGatewayEventName`: it adds the broader surface Hermes
 * documents (sudo/secret prompts, session lifecycle, subagent error/blocked,
 * image attach responses) plus the request methods features call. Unknown names
 * are still accepted via the `(string & {})` tail and classify as
 * `unsupported`. */
export type RawHermesEventName =
  // Connection + session
  | "gateway.ready"
  | "session.info"
  // Assistant message stream
  | "message.start"
  | "message.delta"
  | "message.complete"
  | "thinking.delta"
  | "reasoning.delta"
  | "status.update"
  // Tools
  | "tool.start"
  | "tool.progress"
  | "tool.complete"
  // Pending actions (require a user response)
  | "clarify.request"
  | "clarify.response"
  | "approval.request"
  | "approval.response"
  | "sudo.request"
  | "secret.request"
  // Subagents / background activity
  | "subagent.start"
  | "subagent.tool"
  | "subagent.progress"
  | "subagent.thinking"
  | "subagent.complete"
  | "subagent.error"
  | "subagent.blocked"
  // Lifecycle
  | "lifecycle.start"
  | "lifecycle.update"
  | "lifecycle.complete"
  | "session.start"
  | "session.complete"
  // Misc
  | "image.attach"
  | "error"
  | (string & {});

/** Request methods the control plane wraps in `methods.ts`. Modeled here so the
 * compatibility matrix and trace tooling can share one source of truth. */
export type RawHermesMethodName =
  | "prompt.submit"
  | "session.steer"
  | "session.branch"
  | "session.compress"
  | "session.usage"
  | "command.dispatch"
  | "sudo.respond"
  | "secret.respond"
  | "subagent.interrupt"
  | "image.attach"
  | (string & {});

/**
 * The union of payload fields Hermes is observed to send across all event
 * types. A single permissive shape (rather than one per event) keeps the
 * classifier's reads honest: it must null-check every field because the wire
 * makes no guarantees. Field names mirror what the existing runtime already
 * reads (`request_id`/`id`, `tool_name`/`tool`, `subagent_id`, …).
 */
export type RawHermesPayload = {
  // Identity / correlation
  id?: unknown;
  request_id?: unknown;
  requestId?: unknown;
  message_id?: unknown;
  messageId?: unknown;
  tool_call_id?: unknown;
  toolCallId?: unknown;
  call_id?: unknown;

  // Text-bearing fields (streamed deltas, summaries, results)
  text?: unknown;
  delta?: unknown;
  message?: unknown;
  content?: unknown;
  summary?: unknown;
  output?: unknown;
  result?: unknown;
  status?: unknown;
  role?: unknown;

  // Tools
  name?: unknown;
  tool_name?: unknown;
  tool?: unknown;
  tool_preview?: unknown;
  arguments?: unknown;
  args?: unknown;

  // Clarify
  question?: unknown;
  choices?: unknown;
  answer?: unknown;

  // Approval
  command?: unknown;
  description?: unknown;
  allow_permanent?: unknown;
  allowPermanent?: unknown;

  // Sudo / privilege escalation
  reason?: unknown;
  mode?: unknown;

  // Secret request (the value itself must never be present in a normalized
  // event — only metadata about which key is wanted)
  key_name?: unknown;
  keyName?: unknown;
  key?: unknown;

  // Subagents
  subagent_id?: unknown;
  subagentId?: unknown;
  handle?: unknown;
  parent_session_id?: unknown;
  parentSessionId?: unknown;
  task_index?: unknown;
  task_count?: unknown;
  goal?: unknown;

  // Error
  code?: unknown;
  recoverable?: unknown;

  // Anything else the gateway sends.
  [key: string]: unknown;
};
