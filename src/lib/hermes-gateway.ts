export type HermesGatewayEventName =
  | "gateway.ready"
  | "session.info"
  | "message.start"
  | "message.delta"
  | "message.interim"
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
  | "approval.expire"
  | "subagent.start"
  | "subagent.tool"
  | "subagent.progress"
  | "subagent.thinking"
  | "subagent.complete"
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

type QueuedSend = {
  id: string | number;
  method: string;
  payload: string;
};

type QueuedEvent = {
  event: HermesGatewayEvent;
  handlers: readonly ((event: HermesGatewayEvent) => void)[];
  socket: WebSocket;
};

// Browser WebSockets expose bufferedAmount but no drain event. Stop adding to
// the browser-owned buffer once it reaches 1 MiB, then poll until it drains
// enough to resume the bounded application-owned FIFO.
const SEND_BUFFER_HIGH_WATER_BYTES = 1024 * 1024;
const SEND_QUEUE_LIMIT = 128;
const SEND_QUEUE_POLL_INTERVAL_MS = 16;

// Leave half of a 60 Hz frame for rendering and other main-thread work. One
// handler cannot be preempted, but a burst of individually cheap frames is
// split into FIFO batches with a task boundary between them.
const EVENT_DISPATCH_BUDGET_MS = 8;

const clientsByMode = new Map<boolean, Set<HermesGatewayClient>>();

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

/** A request received no response before its caller-owned deadline. Keeping
 * this distinct from ordinary gateway failures lets the existing active-list
 * poll count silent stalls without treating explicit disconnects as misses. */
export class HermesGatewayRequestTimeoutError extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`Hermes request timed out: ${method}`);
    this.name = "HermesGatewayRequestTimeoutError";
    this.method = method;
  }
}

/** A request could not enter the bounded application-owned send queue. */
export class HermesGatewaySendQueueOverflowError extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`Hermes send queue is full; request was not sent: ${method}`);
    this.name = "HermesGatewaySendQueueOverflowError";
    this.method = method;
  }
}

/** Converts a mode-wide liveness failure into the same unexpected-close signal
 * used for ordinary transport drops. Each client immediately detaches its
 * silent socket, so reconnect does not wait for the browser's TCP close timer. */
export function forceDisconnectHermesGatewayClients(fullMode: boolean) {
  for (const client of [...(clientsByMode.get(fullMode) ?? [])]) {
    client.forceDisconnect();
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
  private sendQueue: QueuedSend[] = [];
  private sendQueueTimer?: number;
  private eventQueue: QueuedEvent[] = [];
  private eventQueueHead = 0;
  private eventDispatchScheduled = false;
  private eventDispatchTimer?: number;

  constructor(private readonly fullMode?: boolean) {
    this.registerForMode();
  }

  async connect(wsUrl: string) {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    // Coalesce concurrent connects: a second caller arriving while the
    // handshake is in flight must not kill the first caller's socket — it
    // just awaits the same connection attempt.
    if (this.connectPromise) return this.connectPromise;
    this.close();
    this.registerForMode();
    const socket = new WebSocket(wsUrl);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.handleMessage(socket, event.data));
    socket.addEventListener("close", () => {
      // A stale socket's close event must not reject requests pending on
      // the socket that replaced it, nor notify close listeners.
      this.handleUnexpectedClose(socket);
    });
    const connectPromise = new Promise<void>((resolve, reject) => {
      let opened = false;
      const failInitialConnection = (error: Error) => {
        if (opened) return;
        if (this.socket === socket) {
          this.socket = undefined;
          this.unregisterFromMode();
        }
        reject(error);
      };
      const timer = window.setTimeout(() => {
        failInitialConnection(new Error("Hermes gateway connection timed out."));
        socket.close();
      }, 15000);
      socket.addEventListener(
        "open",
        () => {
          window.clearTimeout(timer);
          opened = true;
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          window.clearTimeout(timer);
          failInitialConnection(new Error("Could not connect to Hermes gateway."));
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
    this.unregisterFromMode();
    this.rejectQueuedSends(new Error("Hermes gateway connection closed."));
    this.clearTransportQueues();
    socket?.close();
  }

  /** Declares the current OPEN socket unhealthy and synchronously runs the
   * unexpected-close path. Browser WebSocket.close() can itself wait on a
   * wedged TCP peer, so detach and notify before asking the old socket to
   * close. */
  forceDisconnect() {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    this.handleUnexpectedClose(socket);
    socket.close();
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

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 120000) {
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
          this.removeQueuedSend(id);
          reject(new HermesGatewayRequestTimeoutError(method));
        }
      }, timeoutMs);
      this.pending.set(id, pending);
      try {
        this.sendOrQueue(socket, {
          id,
          method,
          payload: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
      } catch (error) {
        if (this.pending.delete(id)) {
          if (pending.timer) window.clearTimeout(pending.timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }

  private sendOrQueue(socket: WebSocket, send: QueuedSend) {
    if (this.sendQueue.length === 0 && socket.bufferedAmount < SEND_BUFFER_HIGH_WATER_BYTES) {
      socket.send(send.payload);
      return;
    }
    if (this.sendQueue.length >= SEND_QUEUE_LIMIT) {
      throw new HermesGatewaySendQueueOverflowError(send.method);
    }
    this.sendQueue.push(send);
    this.flushSendQueue(socket);
  }

  private flushSendQueue(socket: WebSocket) {
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    while (this.sendQueue.length > 0 && socket.bufferedAmount < SEND_BUFFER_HIGH_WATER_BYTES) {
      const send = this.sendQueue.shift();
      if (!send || !this.pending.has(send.id)) continue;
      try {
        socket.send(send.payload);
      } catch (error) {
        const pending = this.pending.get(send.id);
        if (!pending) continue;
        if (pending.timer) window.clearTimeout(pending.timer);
        this.pending.delete(send.id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (this.sendQueue.length > 0) {
      this.scheduleSendQueueFlush(socket);
    } else if (this.sendQueueTimer !== undefined) {
      window.clearTimeout(this.sendQueueTimer);
      this.sendQueueTimer = undefined;
    }
  }

  private scheduleSendQueueFlush(socket: WebSocket) {
    if (this.sendQueueTimer !== undefined) return;
    this.sendQueueTimer = window.setTimeout(() => {
      this.sendQueueTimer = undefined;
      this.flushSendQueue(socket);
    }, SEND_QUEUE_POLL_INTERVAL_MS);
  }

  private removeQueuedSend(id: string | number) {
    const index = this.sendQueue.findIndex((send) => send.id === id);
    if (index !== -1) this.sendQueue.splice(index, 1);
    if (this.sendQueue.length === 0 && this.sendQueueTimer !== undefined) {
      window.clearTimeout(this.sendQueueTimer);
      this.sendQueueTimer = undefined;
    }
  }

  private handleMessage(socket: WebSocket, raw: unknown) {
    if (this.socket !== socket) return;
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
          new HermesGatewayError(frame.error.message ?? "Hermes RPC failed.", frame.error.code),
        );
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (frame.method === "event" && frame.params?.type) {
      // Capture listener ownership at ingress so a listener attached while a
      // burst is yielding cannot observe frames that predate its subscription.
      this.eventQueue.push({ event: frame.params, handlers: [...this.handlers], socket });
      this.scheduleEventDispatch();
    }
  }

  private scheduleEventDispatch() {
    if (this.eventDispatchScheduled) return;
    this.eventDispatchScheduled = true;
    queueMicrotask(() => this.dispatchEventBatch());
  }

  private dispatchEventBatch() {
    const startedAt = performance.now();
    while (this.eventQueueHead < this.eventQueue.length) {
      const queued = this.eventQueue[this.eventQueueHead];
      this.eventQueueHead += 1;
      if (queued.socket === this.socket) {
        try {
          for (const handler of queued.handlers) {
            if (this.handlers.has(handler)) handler(queued.event);
          }
        } catch (error) {
          // Match browser event-listener behavior: report a handler failure
          // without stranding later frames in the transport queue.
          window.setTimeout(() => {
            throw error;
          }, 0);
        }
      }
      if (performance.now() - startedAt >= EVENT_DISPATCH_BUDGET_MS) break;
    }
    if (this.eventQueueHead < this.eventQueue.length) {
      // A microtask starts each batch; a timer between batches is the actual
      // event-loop yield that lets rendering and input run.
      this.eventDispatchTimer = window.setTimeout(() => {
        this.eventDispatchTimer = undefined;
        queueMicrotask(() => this.dispatchEventBatch());
      }, 0);
      return;
    }
    this.eventQueue = [];
    this.eventQueueHead = 0;
    this.eventDispatchScheduled = false;
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pending) {
      if (pending.timer) window.clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private rejectQueuedSends(error: Error) {
    for (const send of this.sendQueue) {
      const pending = this.pending.get(send.id);
      if (!pending) continue;
      if (pending.timer) window.clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(send.id);
    }
  }

  private handleUnexpectedClose(socket: WebSocket) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.unregisterFromMode();
    this.rejectAll(new Error("Hermes gateway connection closed."));
    this.clearTransportQueues();
    for (const handler of [...this.closeHandlers]) handler();
  }

  private clearTransportQueues() {
    this.sendQueue = [];
    if (this.sendQueueTimer !== undefined) {
      window.clearTimeout(this.sendQueueTimer);
      this.sendQueueTimer = undefined;
    }
    this.eventQueue = [];
    this.eventQueueHead = 0;
    this.eventDispatchScheduled = false;
    if (this.eventDispatchTimer !== undefined) {
      window.clearTimeout(this.eventDispatchTimer);
      this.eventDispatchTimer = undefined;
    }
  }

  private registerForMode() {
    if (this.fullMode === undefined) return;
    const clients = clientsByMode.get(this.fullMode) ?? new Set<HermesGatewayClient>();
    clients.add(this);
    clientsByMode.set(this.fullMode, clients);
  }

  private unregisterFromMode() {
    if (this.fullMode === undefined) return;
    const clients = clientsByMode.get(this.fullMode);
    clients?.delete(this);
    if (clients?.size === 0) clientsByMode.delete(this.fullMode);
  }
}

export type HermesSessionCreateResponse = {
  session_id?: string;
  id?: string;
  [key: string]: unknown;
};
