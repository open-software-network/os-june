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

export type CreateSessionParams = {
  title: string;
  cols: number;
  model?: string;
  reasoningEffort?: string;
  profile?: string;
  enabledToolsets?: readonly string[];
};
export type SubmitPromptParams = {
  /** The session's RUNTIME id (not the stored id). */
  sessionId: string;
  text: string;
  /** An agent-run scope that may narrow, but never expand, the gateway allowlist. */
  enabledToolsets?: readonly string[];
};
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
  /** The session's write-access mode. Carried so callers route the request
   * through the gateway that owns this session's process; the seam itself does
   * not open gateways. */
  mode: HermesMode;
  sessionId: string;
  /** The provider model id to use for this session (e.g. a Venice model id). */
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
export type SetSessionReasoningEffortParams = {
  /** The session's RUNTIME id (not the stored id): config.set looks the
   * session up in the gateway's live-session map. */
  sessionId: string;
  /** A Hermes reasoning-effort string: none, minimal, low, medium, high, or
   * xhigh. Callers map June's thinking levels onto these in
   * `thinking-level.ts`; this seam passes the wire value through untouched. */
  effort: string;
};
export type AttachImageParams = {
  sessionId: string;
  mimeType: string;
  dataBase64: string;
  fileName?: string;
};
export type AttachImagePathParams = {
  sessionId: string;
  path: string;
};

/** The typed command surface. Each call resolves to whatever the gateway
 * returns (typed by the caller via the generic on `request`). */
export type HermesMethods = {
  createSession<T = unknown>(params: CreateSessionParams): Promise<T>;
  submitPrompt(params: SubmitPromptParams): Promise<unknown>;
  steerSession(params: SteerSessionParams): Promise<unknown>;
  branchSession(params: BranchSessionParams): Promise<unknown>;
  compressSession(params: CompressSessionParams): Promise<unknown>;
  getSessionUsage(params: SessionUsageParams, timeoutMs?: number): Promise<unknown>;
  dispatchCommand(params: DispatchCommandParams): Promise<unknown>;
  /** Switches the model on an idle live session with session-scoped
   * `config.set`. Hermes rejects this mutation with 4009 while the session is
   * running, so callers must defer it until immediately before the next prompt.
   * The gateway result is the source of truth that the switch took. */
  switchActiveSessionModel(params: SwitchActiveSessionModelParams): Promise<unknown>;
  respondToSudo(params: RespondToSudoParams): Promise<unknown>;
  respondToSecret(params: RespondToSecretParams): Promise<unknown>;
  interruptSubagent(params: InterruptSubagentParams): Promise<unknown>;
  /** Changes how much a LIVE session reasons before answering by setting the
   * gateway's `reasoning` config key (the same surface the TUI's /reasoning
   * command uses). The gateway applies the new effort to the session's agent
   * immediately, persists it into the session's stored runtime config (so
   * resume keeps it), and emits a fresh session.info. */
  setSessionReasoningEffort(params: SetSessionReasoningEffortParams): Promise<unknown>;
  /** Preferred desktop attach path. Rust first snapshots the image into the
   * live session's June workspace directory, then this passes only that native
   * path to the co-located Hermes gateway. */
  attachImagePath(params: AttachImagePathParams): Promise<unknown>;
  /** Additive remote-client fallback for callers without a gateway-local path. */
  attachImage(params: AttachImageParams): Promise<unknown>;
};

export function createHermesMethods(client: HermesRequestLike): HermesMethods {
  const request: HermesRequestFn =
    typeof client === "function" ? client : client.request.bind(client);

  return {
    createSession<T = unknown>({
      title,
      cols,
      model,
      reasoningEffort,
      profile,
      enabledToolsets,
    }: CreateSessionParams): Promise<T> {
      return request("session.create", {
        title,
        cols,
        ...defined({
          model,
          reasoning_effort: reasoningEffort,
          profile,
          enabled_toolsets: enabledToolsets,
        }),
      }) as Promise<T>;
    },
    submitPrompt({ sessionId, text, enabledToolsets }) {
      return request("prompt.submit", {
        session_id: sessionId,
        text,
        ...defined({ enabled_toolsets: enabledToolsets }),
      });
    },
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
    getSessionUsage({ sessionId }, timeoutMs) {
      return request("session.usage", { session_id: sessionId }, timeoutMs);
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
      // not part of the wire payload. `--session` keeps Hermes from persisting
      // the choice as its process-wide default. The user already confirmed the
      // model in June's picker, including any cost implications.
      return request("config.set", {
        session_id: sessionId,
        key: "model",
        value: `${model} --session`,
        confirm_expensive_model: true,
      });
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
    setSessionReasoningEffort({ sessionId, effort }) {
      return request("config.set", {
        session_id: sessionId,
        key: "reasoning",
        value: effort,
      });
    },
    attachImagePath({ sessionId, path }) {
      return request("image.attach", {
        session_id: sessionId,
        path,
      });
    },
    attachImage({ sessionId, mimeType, dataBase64, fileName }) {
      return request("image.attach_bytes", {
        session_id: sessionId,
        mime_type: mimeType,
        content_base64: dataBase64,
        ...defined({ filename: fileName }),
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
