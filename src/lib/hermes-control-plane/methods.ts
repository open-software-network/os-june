import type { HermesMode } from "./events";

/**
 * Typed command wrappers over the gateway's JSON-RPC `request(...)`. Each
 * function maps a strongly-typed argument object to the snake_case params the
 * gateway expects and returns the raw result. Downstream features (steering,
 * branching, compaction, usage, sudo/secret responses, subagent interrupt,
 * image attach) call these instead of hand-writing `request("session.steer",
 * …)`, so method names and param shapes live in one place and move together
 * with the compatibility matrix.
 *
 * The body is intentionally thin: this layer provides the typed seam: it does
 * not own UI, retries, or optimistic state. It depends on a `request`-like
 * function (or any object exposing one — e.g. {@link
 * import("../hermes-gateway").HermesGatewayClient}) so it never hard-couples to
 * a concrete client and stays trivially mockable in tests.
 */

/** The minimal request surface this module needs. Deliberately non-generic
 * (resolving to `unknown`) so a plain function, a test mock, and the generic
 * `HermesGatewayClient.request<T>` all satisfy it; callers refine the result
 * type at the use site. */
export type HermesRequestFn = (
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

export type HermesRequestLike = HermesRequestFn | { request: HermesRequestFn };

export type SteerSessionParams = { sessionId: string; text: string };
export type BranchSessionParams = {
  sessionId: string;
  /** Fork the conversation from this message; omitted forks from the tip. */
  fromMessageId?: string;
};
export type CompressSessionParams = { sessionId: string };
export type SessionUsageParams = { sessionId: string };
export type DispatchCommandParams = {
  sessionId: string;
  command: string;
  args?: Record<string, unknown>;
};
export type SwitchActiveSessionModelParams = {
  /** The running session's write-access mode. Carried so callers route the
   * dispatch through the gateway that owns this session's process; the seam
   * itself does not open gateways. */
  mode: HermesMode;
  sessionId: string;
  /** The provider model id to switch to (e.g. a Venice model id). */
  model: string;
};
export type RespondToSudoParams = {
  sessionId: string;
  requestId: string;
  approved: boolean;
  /** The mode to grant when approving (e.g. escalate to `unrestricted`). */
  mode?: HermesMode;
};
export type RespondToSecretParams = {
  sessionId: string;
  requestId: string;
  /** The secret value the user provided. Sent to the gateway; never logged or
   * placed on a normalized event. */
  value: string;
};
export type InterruptSubagentParams = {
  sessionId: string;
  subagentId: string;
};
export type AttachImageParams = {
  sessionId: string;
  mimeType: string;
  dataBase64: string;
};

/** The typed command surface. Each call resolves to whatever the gateway
 * returns (typed by the caller via the generic on `request`). */
export type HermesMethods = {
  steerSession(params: SteerSessionParams): Promise<unknown>;
  branchSession(params: BranchSessionParams): Promise<unknown>;
  compressSession(params: CompressSessionParams): Promise<unknown>;
  getSessionUsage(params: SessionUsageParams): Promise<unknown>;
  dispatchCommand(params: DispatchCommandParams): Promise<unknown>;
  /** Switches the model on a LIVE session by dispatching the `/model <model>`
   * slash command (built on {@link dispatchCommand}). The gateway's result is
   * the source of truth that the switch took — there is no separate confirming
   * event June can rely on (raw `model.switch`/`model.changed` frames classify
   * as `unsupported`). */
  switchActiveSessionModel(
    params: SwitchActiveSessionModelParams,
  ): Promise<unknown>;
  respondToSudo(params: RespondToSudoParams): Promise<unknown>;
  respondToSecret(params: RespondToSecretParams): Promise<unknown>;
  interruptSubagent(params: InterruptSubagentParams): Promise<unknown>;
  attachImage(params: AttachImageParams): Promise<unknown>;
};

export function createHermesMethods(client: HermesRequestLike): HermesMethods {
  const request: HermesRequestFn =
    typeof client === "function" ? client : client.request.bind(client);

  return {
    steerSession({ sessionId, text }) {
      return request("session.steer", {
        session_id: sessionId,
        text,
      });
    },
    branchSession({ sessionId, fromMessageId }) {
      return request("session.branch", {
        session_id: sessionId,
        ...defined({ from_message_id: fromMessageId }),
      });
    },
    compressSession({ sessionId }) {
      return request("session.compress", { session_id: sessionId });
    },
    getSessionUsage({ sessionId }) {
      return request("session.usage", { session_id: sessionId });
    },
    dispatchCommand({ sessionId, command, args }) {
      return request("command.dispatch", {
        session_id: sessionId,
        command,
        ...defined({ args }),
      });
    },
    switchActiveSessionModel({ sessionId, model }) {
      // The model is selected against the gateway that already owns this
      // session, so `mode` only steers gateway routing at the call site and is
      // not part of the wire payload. Built on dispatchCommand so the
      // command.dispatch shape stays defined in exactly one place.
      return this.dispatchCommand({ sessionId, command: `/model ${model}` });
    },
    respondToSudo({ sessionId, requestId, approved, mode }) {
      return request("sudo.respond", {
        session_id: sessionId,
        request_id: requestId,
        approved,
        ...defined({ mode }),
      });
    },
    respondToSecret({ sessionId, requestId, value }) {
      return request("secret.respond", {
        session_id: sessionId,
        request_id: requestId,
        value,
      });
    },
    interruptSubagent({ sessionId, subagentId }) {
      return request("subagent.interrupt", {
        session_id: sessionId,
        subagent_id: subagentId,
      });
    },
    attachImage({ sessionId, mimeType, dataBase64 }) {
      return request("image.attach", {
        session_id: sessionId,
        mime_type: mimeType,
        data_base64: dataBase64,
      });
    },
  };
}

/** Drops keys whose value is `undefined` so the gateway receives a clean
 * params object rather than explicit nulls/undefined for omitted optionals. */
function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key as keyof T] = value as T[keyof T];
  }
  return out;
}
