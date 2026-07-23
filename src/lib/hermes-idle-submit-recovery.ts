import {
  forceDisconnectHermesGatewayClients,
  type HermesGatewayClient,
  HermesGatewayRequestTimeoutError,
} from "./hermes-gateway";

export const HERMES_IDLE_SUBMIT_PROBE_TIMEOUT_MS = 3_000;

export type HermesSubmitGateway = {
  currentGateway(): HermesGatewayClient;
  request<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
};

type HermesIdleSubmitRecoveryOptions = {
  fullMode: boolean;
  gateway: HermesGatewayClient;
  shouldProbeFirstRequest: () => boolean;
  reconnect: () => Promise<HermesGatewayClient>;
};

/**
 * Gives only the first Gateway request of an idle submit a short deadline.
 * A silent OPEN socket cannot be distinguished from a healthy one before a
 * request, so a timeout converts it into the established unexpected-close
 * path and retries the same transport request once on a fresh connection.
 *
 * The helper is scoped to one submit. It never retries prompt preparation or
 * the composer action, and later requests keep their caller/default deadlines.
 */
export function createHermesIdleSubmitGateway({
  fullMode,
  gateway,
  shouldProbeFirstRequest,
  reconnect,
}: HermesIdleSubmitRecoveryOptions): HermesSubmitGateway {
  let currentGateway = gateway;
  let firstRequest = true;

  const requestNormally = <T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ) =>
    timeoutMs === undefined
      ? currentGateway.request<T>(method, params)
      : currentGateway.request<T>(method, params, timeoutMs);

  return {
    currentGateway: () => currentGateway,
    async request<T>(
      method: string,
      params: Record<string, unknown> = {},
      timeoutMs?: number,
    ): Promise<T> {
      const useIdleProbe = firstRequest && shouldProbeFirstRequest();
      firstRequest = false;
      if (!useIdleProbe) return requestNormally<T>(method, params, timeoutMs);

      const probeTimeoutMs =
        timeoutMs === undefined
          ? HERMES_IDLE_SUBMIT_PROBE_TIMEOUT_MS
          : Math.min(timeoutMs, HERMES_IDLE_SUBMIT_PROBE_TIMEOUT_MS);
      try {
        return await currentGateway.request<T>(method, params, probeTimeoutMs);
      } catch (error) {
        if (!(error instanceof HermesGatewayRequestTimeoutError)) throw error;
        forceDisconnectHermesGatewayClients(fullMode);
        currentGateway = await reconnect();
        return requestNormally<T>(method, params, timeoutMs);
      }
    },
  };
}
