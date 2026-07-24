import {
  forceDisconnectHermesGatewayClients,
  type HermesGatewayClient,
  HermesGatewayRequestTimeoutError,
} from "./hermes-gateway";

export const HERMES_IDLE_SUBMIT_PROBE_TIMEOUT_MS = 3_000;
const HERMES_IDLE_SUBMIT_PROBE_METHOD = "session.active_list";

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

const idleSubmitPreflights = new Map<boolean, Promise<HermesGatewayClient>>();

export function resetHermesIdleSubmitRecoveryForTests() {
  idleSubmitPreflights.clear();
}

function startIdleSubmitPreflight({
  fullMode,
  gateway,
  reconnect,
}: Omit<HermesIdleSubmitRecoveryOptions, "shouldProbeFirstRequest">) {
  const existing = idleSubmitPreflights.get(fullMode);
  if (existing) return existing;

  const preflight = (async () => {
    try {
      await gateway.request(
        HERMES_IDLE_SUBMIT_PROBE_METHOD,
        {},
        HERMES_IDLE_SUBMIT_PROBE_TIMEOUT_MS,
      );
      return gateway;
    } catch (error) {
      if (!(error instanceof HermesGatewayRequestTimeoutError)) throw error;
      forceDisconnectHermesGatewayClients(fullMode);
      const recoveredGateway = await reconnect();
      await recoveredGateway.request(
        HERMES_IDLE_SUBMIT_PROBE_METHOD,
        {},
        HERMES_IDLE_SUBMIT_PROBE_TIMEOUT_MS,
      );
      return recoveredGateway;
    }
  })();
  idleSubmitPreflights.set(fullMode, preflight);
  const clearPreflight = () => {
    if (idleSubmitPreflights.get(fullMode) === preflight) {
      idleSubmitPreflights.delete(fullMode);
    }
  };
  void preflight.then(clearPreflight, clearPreflight);
  return preflight;
}

/**
 * Runs one read-only liveness request before the first Gateway request of an
 * idle submit.
 *
 * A silent OPEN socket cannot be distinguished from a healthy one before a
 * request, so a preflight timeout converts it into the established
 * unexpected-close path and retries only the read-only preflight once on a
 * fresh connection. The caller's actual request is sent exactly once with its
 * ordinary deadline. In particular, prompt.submit and session.create are
 * never the probe and are never transport-retried.
 *
 * Same-mode submits share an in-flight preflight so one recovery cannot close
 * a socket while another submit is sending its first request.
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
      const inFlightPreflight = idleSubmitPreflights.get(fullMode);
      const useIdleProbe =
        firstRequest && (inFlightPreflight !== undefined || shouldProbeFirstRequest());
      firstRequest = false;
      if (useIdleProbe) {
        const preflight =
          inFlightPreflight ??
          startIdleSubmitPreflight({
            fullMode,
            gateway: currentGateway,
            reconnect,
          });
        currentGateway = await preflight;
      }
      return requestNormally<T>(method, params, timeoutMs);
    },
  };
}
