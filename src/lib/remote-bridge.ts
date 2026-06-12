import { listen } from "@tauri-apps/api/event";
import { HermesGatewayClient } from "./hermes-gateway";
import type { HermesGatewayEvent } from "./hermes-gateway";
import {
  hermesBridgeStatus,
  remoteSend,
  startHermesBridge,
} from "./tauri";

/**
 * The host-side agent bridge for "control from your phone".
 *
 * The Rust host owns the relay socket (so the OS Accounts token stays out of
 * the webview) and emits a `remote-prompt` event for each prompt the phone
 * sends. This module runs that prompt through the local agent over the
 * existing Hermes gateway and streams the agent's output back to the phone via
 * the `remote_send` command, frame by frame. Reusing the gateway client keeps
 * remote turns identical to in-app ones.
 *
 * One dedicated agent session is reused across remote prompts, so the phone
 * holds a continuous conversation rather than a fresh context each time.
 */

type RemotePromptPayload = { text?: string };

/** Maps a live gateway event to the frame the phone should receive, or null
 * for events the phone doesn't render (tool steps, thinking, presence). Pure,
 * so the protocol mapping is unit-tested without a live gateway. */
export function agentEventToRemoteFrame(
  event: HermesGatewayEvent,
): string | null {
  switch (event.type) {
    case "message.delta": {
      const text = deltaText(event);
      return text ? JSON.stringify({ type: "delta", text }) : null;
    }
    case "message.complete":
      return JSON.stringify({ type: "done" });
    case "error":
      return JSON.stringify({
        type: "error",
        message: deltaText(event) || "The agent hit an error.",
      });
    case "approval.request":
      // Outward actions need a decision the phone can't safely make; tell the
      // user to finish that step on their Mac rather than auto-approving.
      return JSON.stringify({
        type: "message",
        text: "June needs your approval for the next step. Open June on your Mac to continue.",
      });
    default:
      return null;
  }
}

function deltaText(event: HermesGatewayEvent): string {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload) return "";
  for (const key of ["text", "delta", "message", "content"]) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

export type RemoteBridge = { stop: () => void };

/**
 * Wires the host bridge: listens for `remote-prompt`, ensures a gateway
 * connection and a dedicated remote session, and streams each turn back to
 * the phone. Returns a handle whose `stop()` tears the bridge down.
 */
export function startRemoteBridge(): RemoteBridge {
  let gateway: HermesGatewayClient | undefined;
  let sessionId: string | undefined;
  let unEvent: (() => void) | undefined;
  let stopped = false;

  async function ensureSession(): Promise<{
    gateway: HermesGatewayClient;
    sessionId: string;
  }> {
    const status = await hermesBridgeStatus();
    const bridge = status.running ? status : await startHermesBridge();
    const wsUrl = bridge.connection?.wsUrl;
    if (!wsUrl) throw new Error("Hermes did not return a gateway URL.");
    if (!gateway) gateway = new HermesGatewayClient();
    await gateway.connect(wsUrl);
    if (!unEvent) {
      // One subscription forwards every event for our session to the phone.
      unEvent = gateway.onEvent((event) => {
        if (event.session_id && event.session_id !== sessionId) return;
        const frame = agentEventToRemoteFrame(event);
        if (frame) void remoteSend(frame).catch(() => undefined);
      });
    }
    if (!sessionId) {
      const created = await gateway.request<{ session_id: string }>(
        "session.create",
        {},
      );
      sessionId = created.session_id;
    }
    return { gateway, sessionId };
  }

  const promptListener = listen<RemotePromptPayload>(
    "remote-prompt",
    (event) => {
      const text = event.payload?.text?.trim();
      if (!text || stopped) return;
      void (async () => {
        try {
          const { gateway, sessionId } = await ensureSession();
          await gateway.request("prompt.submit", {
            session_id: sessionId,
            text,
          });
        } catch (error) {
          void remoteSend(
            JSON.stringify({
              type: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "Could not reach the agent.",
            }),
          ).catch(() => undefined);
        }
      })();
    },
  );

  return {
    stop() {
      stopped = true;
      unEvent?.();
      gateway?.close();
      void promptListener.then((dispose) => dispose());
    },
  };
}
