export type HermesGatewayEventName =
  | "gateway.ready"
  | "session.info"
  | "message.start"
  | "message.delta"
  | "message.complete"
  | "thinking.delta"
  | "reasoning.delta"
  | "status.update"
  | "tool.start"
  | "tool.progress"
  | "tool.complete"
  | "clarify.request"
  | "clarify.response"
  | "approval.request"
  | "approval.response"
  | "error"
  | (string & {});

export type HermesGatewayEvent<P = unknown> = {
  type: HermesGatewayEventName;
  session_id?: string;
  payload?: P;
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: number;
};

type Frame = {
  id?: string | number | null;
  method?: string;
  params?: HermesGatewayEvent;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/** RPC rejection from the gateway, keeping the JSON-RPC error code so callers
 * can branch on well-known conditions instead of matching message strings. */
export class HermesGatewayError extends Error {
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "HermesGatewayError";
    this.code = code;
  }
}

// The gateway rejects prompt.submit (and other mutations) with 4009 while a
// turn is running — see tui_gateway/server.py `_err(rid, 4009, "session busy")`.
const SESSION_BUSY_CODE = 4009;

export function isSessionBusyError(err: unknown) {
  return err instanceof HermesGatewayError && err.code === SESSION_BUSY_CODE;
}

export class HermesGatewayClient {
  private nextId = 0;
  private pending = new Map<string | number, PendingCall>();
  private socket?: WebSocket;
  private connectPromise?: Promise<void>;
  private handlers = new Set<(event: HermesGatewayEvent) => void>();
  private closeHandlers = new Set<() => void>();

  async connect(wsUrl: string) {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    // Coalesce concurrent connects: a second caller arriving while the
    // handshake is in flight must not kill the first caller's socket — it
    // just awaits the same connection attempt.
    if (this.connectPromise) return this.connectPromise;
    this.close();
    const socket = new WebSocket(wsUrl);
    this.socket = socket;
    socket.addEventListener("message", (event) =>
      this.handleMessage(event.data),
    );
    socket.addEventListener("close", () => {
      // A stale socket's close event must not reject requests pending on
      // the socket that replaced it, nor notify close listeners.
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.rejectAll(new Error("Hermes gateway connection closed."));
      for (const handler of [...this.closeHandlers]) handler();
    });
    const connectPromise = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error("Hermes gateway connection timed out."));
        socket.close();
      }, 15000);
      socket.addEventListener(
        "open",
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          window.clearTimeout(timer);
          reject(new Error("Could not connect to Hermes gateway."));
        },
        { once: true },
      );
    }).finally(() => {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = undefined;
      }
    });
    this.connectPromise = connectPromise;
    return connectPromise;
  }

  close() {
    // Detach before closing so the close event reads as intentional — the
    // identity guard in the close handler then skips rejectAll/onClose.
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  onEvent(handler: (event: HermesGatewayEvent) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // Fires only for unexpected disconnects of the current socket — an explicit
  // close() or a superseded (stale) socket does not notify.
  onClose(handler: () => void) {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 120000,
  ) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Hermes gateway is not connected."));
    }
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingCall = {
        resolve: (value) => resolve(value as T),
        reject,
      };
      pending.timer = window.setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Hermes request timed out: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, pending);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private handleMessage(raw: unknown) {
    let frame: Frame;
    try {
      frame = JSON.parse(String(raw)) as Frame;
    } catch {
      return;
    }
    if (frame.id !== undefined && frame.id !== null) {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      if (pending.timer) window.clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.error) {
        pending.reject(
          new HermesGatewayError(
            frame.error.message ?? "Hermes RPC failed.",
            frame.error.code,
          ),
        );
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (frame.method === "event" && frame.params?.type) {
      for (const handler of this.handlers) handler(frame.params);
    }
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pending) {
      if (pending.timer) window.clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export type HermesSessionCreateResponse = {
  session_id?: string;
  id?: string;
  [key: string]: unknown;
};
