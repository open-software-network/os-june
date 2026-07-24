import {
  createHermesMethods,
  type CreateSessionParams,
  type HermesMode,
} from "./hermes-control-plane";
import type { HermesGatewayClient } from "./hermes-gateway";
import {
  createHermesIdleSubmitGateway,
  type HermesSubmitGateway,
} from "./hermes-idle-submit-recovery";
import { applySessionModelWhenIdle } from "./hermes-next-prompt-model";
import {
  reserveHermesSessionDispatch,
  type HermesSessionDispatchReservation,
} from "./hermes-session-dispatch-mutex";

type MaybePromise<Value> = Value | Promise<Value>;

export type HermesRuntimeSessionResponse = {
  session_id?: string;
  stored_session_id?: string;
};

export type HermesRunSessionCreation = {
  params: CreateSessionParams;
  profileAssignment?: {
    profile: string;
    assign: (storedSessionId: string, profile: string) => Promise<void>;
    timing?: "before-session-resolved" | "after-session-resolved";
  };
};

export type HermesRunSubmissionContext = {
  created: HermesRuntimeSessionResponse | undefined;
  createdUnderProfile: string | undefined;
  dispatchReservation: HermesSessionDispatchReservation;
  runtimeSessionId: string;
  storedSessionId: string;
  submitGateway: HermesSubmitGateway;
};

type HermesResolvedSessionContext = Omit<HermesRunSubmissionContext, "runtimeSessionId">;

export type HermesPreparedRunPrompt = {
  text: string;
  enabledToolsets?: readonly string[];
};

export type HermesRunSubmissionResult = HermesRunSubmissionContext & {
  promptAccepted: boolean;
  postAcknowledgementError?: unknown;
};

export type HermesRunSubmissionOptions<RunLease = never> = {
  fullMode: boolean;
  gateway: HermesGatewayClient;
  reconnectGateway: () => Promise<HermesGatewayClient>;
  shouldProbeFirstRequest: () => boolean;
  storedSessionId?: string;
  runtimeSessionId?: string;
  dispatchReservation?: HermesSessionDispatchReservation;
  createSession?: () => MaybePromise<HermesRunSessionCreation>;
  onSessionCreated?: (context: HermesResolvedSessionContext) => MaybePromise<void>;
  onSessionResolved?: (context: HermesResolvedSessionContext) => MaybePromise<void>;
  onRuntimeSessionResolved?: (context: HermesRunSubmissionContext) => MaybePromise<void>;
  applyThinkingLevel?: (context: HermesRunSubmissionContext) => MaybePromise<void>;
  model?: {
    mode: HermesMode;
    modelId: string;
    shouldApply: (context: HermesRunSubmissionContext) => boolean;
    onApplied?: (context: HermesRunSubmissionContext) => MaybePromise<void>;
  };
  attach?: (context: HermesRunSubmissionContext) => MaybePromise<void>;
  preparePrompt: (
    context: HermesRunSubmissionContext,
  ) => MaybePromise<HermesPreparedRunPrompt | undefined>;
  runLease?: {
    begin: (context: HermesRunSubmissionContext) => Promise<RunLease>;
    release: (context: HermesRunSubmissionContext, lease: RunLease) => Promise<void>;
  };
  beforePrompt?: (
    context: HermesRunSubmissionContext,
    prompt: HermesPreparedRunPrompt,
    lease: RunLease | undefined,
  ) => MaybePromise<void>;
  afterPromptAcknowledged?: (
    context: HermesRunSubmissionContext,
    prompt: HermesPreparedRunPrompt,
    lease: RunLease | undefined,
  ) => MaybePromise<void>;
};

/**
 * Owns the ordered Hermes run protocol shared by every visible chat surface.
 *
 * Presentation and surface-local persistence stay in callbacks, but callers
 * cannot reorder the liveness preflight, create/resume resolution, per-session
 * FIFO, thinking/model application, attachments, lease begin, prompt
 * acknowledgement, and monitoring handoff. Only the read-only idle probe may
 * transport-retry; a busy model change may wait and retry its documented 4009
 * response. Session creation, resume, attachments, and prompt submission are
 * otherwise invoked once by this module.
 */
export async function submitHermesRun<RunLease = never>({
  fullMode,
  gateway,
  reconnectGateway,
  shouldProbeFirstRequest,
  storedSessionId: initialStoredSessionId,
  runtimeSessionId: initialRuntimeSessionId,
  dispatchReservation: initialDispatchReservation,
  createSession,
  onSessionCreated,
  onSessionResolved,
  onRuntimeSessionResolved,
  applyThinkingLevel,
  model,
  attach,
  preparePrompt,
  runLease,
  beforePrompt,
  afterPromptAcknowledged,
}: HermesRunSubmissionOptions<RunLease>): Promise<HermesRunSubmissionResult> {
  const submitGateway = createHermesIdleSubmitGateway({
    fullMode,
    gateway,
    shouldProbeFirstRequest,
    reconnect: reconnectGateway,
  });
  let dispatchReservation = initialDispatchReservation;

  try {
    let storedSessionId = initialStoredSessionId;
    let created: HermesRuntimeSessionResponse | undefined;
    let createdUnderProfile: string | undefined;
    let profileAssignment: HermesRunSessionCreation["profileAssignment"];

    if (!storedSessionId) {
      if (!createSession) {
        throw new Error("Hermes session creation parameters were not provided.");
      }
      const creation = await createSession();
      created = await createHermesMethods(
        submitGateway,
      ).createSession<HermesRuntimeSessionResponse>(creation.params);
      storedSessionId = created.stored_session_id ?? created.session_id;
      if (!storedSessionId) {
        throw new Error("Hermes did not create a session.");
      }
      dispatchReservation = reserveHermesSessionDispatch(storedSessionId);
      profileAssignment = creation.profileAssignment;
      if (profileAssignment) {
        createdUnderProfile = profileAssignment.profile;
      }
    }

    dispatchReservation ??= reserveHermesSessionDispatch(storedSessionId);
    const resolvedSessionContext: HermesResolvedSessionContext = {
      created,
      createdUnderProfile,
      dispatchReservation,
      storedSessionId,
      submitGateway,
    };
    if (created) {
      await onSessionCreated?.(resolvedSessionContext);
    }
    if (profileAssignment && profileAssignment.timing !== "after-session-resolved") {
      await profileAssignment.assign(storedSessionId, profileAssignment.profile);
    }
    await onSessionResolved?.(resolvedSessionContext);
    if (profileAssignment?.timing === "after-session-resolved") {
      await profileAssignment.assign(storedSessionId, profileAssignment.profile);
    }

    const runtimeSessionId =
      created?.session_id ??
      initialRuntimeSessionId ??
      (
        await submitGateway.request<HermesRuntimeSessionResponse>("session.resume", {
          session_id: storedSessionId,
          cols: 96,
        })
      ).session_id;
    if (!runtimeSessionId) {
      throw new Error("Hermes did not resume the session.");
    }

    const context: HermesRunSubmissionContext = {
      ...resolvedSessionContext,
      runtimeSessionId,
    };
    await onRuntimeSessionResolved?.(context);

    return await dispatchReservation.run(async () => {
      await applyThinkingLevel?.(context);
      if (model?.shouldApply(context)) {
        await applySessionModelWhenIdle(() =>
          createHermesMethods(submitGateway).switchActiveSessionModel({
            mode: model.mode,
            sessionId: runtimeSessionId,
            model: model.modelId,
          }),
        );
        await model.onApplied?.(context);
      }
      await attach?.(context);

      const prompt = await preparePrompt(context);
      if (!prompt) {
        return {
          ...context,
          promptAccepted: false,
        };
      }

      let lease: RunLease | undefined;
      try {
        lease = await runLease?.begin(context);
        await beforePrompt?.(context, prompt, lease);
        await createHermesMethods(submitGateway).submitPrompt({
          sessionId: runtimeSessionId,
          text: prompt.text,
          ...(prompt.enabledToolsets ? { enabledToolsets: prompt.enabledToolsets } : {}),
        });
      } catch (error) {
        if (lease !== undefined && runLease) {
          await runLease.release(context, lease);
        }
        throw error;
      }

      let postAcknowledgementError: unknown;
      try {
        await afterPromptAcknowledged?.(context, prompt, lease);
      } catch (error) {
        postAcknowledgementError = error;
      }
      return {
        ...context,
        promptAccepted: true,
        ...(postAcknowledgementError === undefined ? {} : { postAcknowledgementError }),
      };
    });
  } catch (error) {
    dispatchReservation?.cancel();
    throw error;
  }
}
