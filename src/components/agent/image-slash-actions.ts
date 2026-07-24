import {
  generateImage,
  importHermesBridgeFileBytes,
  providerModelSettings,
  imagePromptMayBeExplicit,
  setImageSafeMode,
  setImageSafeModePromptDismissed,
  type ProviderModelSettingsDto,
} from "../../lib/tauri";
import { hermesModeFor } from "../../lib/hermes-control-plane";
import { attachmentStateFrom } from "../../lib/hermes-image-attach";
import { hermesArtifactStore } from "../../lib/hermes-artifact-store";
import { type HermesSessionDispatchReservation } from "../../lib/hermes-session-dispatch-mutex";
import { messageFromError } from "../../lib/errors";
import { generateChatImage, newImageRequestId } from "../../lib/chat-image-generation";
import { type AgentChatPart } from "../../lib/agent-chat-runtime";
import type { AgentAttachment } from "./agent-workspace-models";
import type {
  ImageSafeModeConsentChoice,
  ImageSafeModeConsentEventPayload,
} from "./agent-workspace-models";
import {
  runningImageSlashTurns,
  upsertStoredImageSlashTurn,
} from "./composer/media-slash-persistence";
import type { createImageSlashActionsDependencies } from "./image-slash-actions-types";

export function createImageSlashActions(dependencies: createImageSlashActionsDependencies) {
  const {
    captureSessionModelTarget,
    clearComposerCommandDraft,
    composerDispatchWasInvalidated,
    creditActionsDisabledReason,
    imageSafeModeConsentRequestRef,
    imageSlashBaseTurnId,
    recordImportedArtifact,
    newSessionModeRef,
    pendingFastPathImagesRef,
    setError,
    setGeneratingImage,
    setHeroLeaving,
    setImageSafeModeConsentRequest,
    setImageTurnsBySession,
    setImportingFiles,
    submitHermesSession,
    updateImageSlashPart,
  } = dependencies;

  async function finishImageSlashGeneration(input: {
    sessionId: string;
    turnId: string;
    prompt: string;
    requestId: string;
    createdAt: string;
    imageCreatedAt: string;
    model?: string;
    safeMode?: boolean;
  }) {
    const { sessionId, turnId, prompt, requestId, createdAt, imageCreatedAt } = input;
    const assistantTurnId = `${turnId}:assistant`;
    try {
      const result = await generateChatImage(
        prompt,
        {
          generate: (text, model, nextRequestId, safeMode) =>
            generateImage(text, model, nextRequestId, safeMode),
          importImageBytes: importHermesBridgeFileBytes,
        },
        input.model,
        requestId,
        input.safeMode,
      );
      if (result.status !== "ok") {
        updateImageSlashPart(sessionId, assistantTurnId, {
          status: "error",
          error: result.message,
        });
        return;
      }
      updateImageSlashPart(sessionId, assistantTurnId, {
        status: "complete",
        dataUrl: result.dataUrl,
        path: result.file.path,
        name: result.file.name,
      });
      upsertStoredImageSlashTurn({
        id: turnId,
        sessionId,
        prompt,
        path: result.file.path,
        name: result.file.name,
        createdAt,
        imageCreatedAt,
        contextPending: true,
      });
      // Mirror into the files drawer/timeline like any artifact the agent
      // touches, so the image is reachable after it scrolls away.
      hermesArtifactStore.recordArtifact(
        {
          sessionId,
          kind: "image",
          action: "attached",
          path: result.file.path,
          displayName: result.file.name,
          previewAvailable: true,
        },
        hermesModeFor(sessionId),
      );
      recordImportedArtifact(result.file);
      // JUN-171 (Phase A): hold the generated image so the user's next message
      // carries it into the model's context (lazy attach). No composer chip -
      // it already renders in-thread as the assistant image turn above. Reuses
      // attachmentStateFrom so it rides the exact structured-attach path a
      // pasted/dropped image would (kind:"image", status:"imported").
      const heldImage: AgentAttachment = {
        ...result.file,
        id: `held-image:${sessionId}:${Date.now()}`,
        sourcePrompt: prompt,
        attachDataUrl: result.dataUrl,
        attach: attachmentStateFrom(result.file, sessionId),
      };
      pendingFastPathImagesRef.current = {
        ...pendingFastPathImagesRef.current,
        [sessionId]: [...(pendingFastPathImagesRef.current[sessionId] ?? []), heldImage],
      };
    } catch (err) {
      updateImageSlashPart(sessionId, assistantTurnId, {
        status: "error",
        error: messageFromError(err),
      });
    } finally {
      setGeneratingImage(false);
      setImportingFiles(false);
    }
  }

  async function retryImageSlashTurn(
    sessionId: string,
    assistantTurnId: string,
    part: Extract<AgentChatPart, { type: "image" }>,
  ) {
    if (part.status !== "error" || !part.requestId) return;
    const now = new Date().toISOString();
    setError(null);
    setImportingFiles(true);
    setGeneratingImage(true);
    updateImageSlashPart(sessionId, assistantTurnId, {
      status: "running",
      error: undefined,
    });
    await finishImageSlashGeneration({
      sessionId,
      turnId: imageSlashBaseTurnId(assistantTurnId),
      prompt: part.prompt,
      requestId: part.requestId,
      createdAt: part.userCreatedAt ?? now,
      imageCreatedAt: part.imageCreatedAt ?? now,
      // Replay the shape pinned at turn creation - resolving the CURRENT
      // settings here would change the June API ledger key and turn a retry
      // into a second billable generation.
      model: part.model,
      safeMode: part.safeMode,
    });
  }

  function requestImageSafeModeConsent(
    variant: "slash" | "agent" | "video-slash",
    ownerDispatchReservation?: HermesSessionDispatchReservation,
  ): Promise<ImageSafeModeConsentChoice> {
    return new Promise((resolve) => {
      const request = { variant, ownerDispatchReservation, resolve };
      imageSafeModeConsentRequestRef.current = request;
      setImageSafeModeConsentRequest(request);
    });
  }

  function resolveImageSafeModeConsent(choice: ImageSafeModeConsentChoice) {
    const request = imageSafeModeConsentRequestRef.current;
    if (!request) return;
    imageSafeModeConsentRequestRef.current = null;
    setImageSafeModeConsentRequest(null);
    request.resolve(choice);
  }

  async function handleAgentImageSafeModeConsentEvent(payload?: ImageSafeModeConsentEventPayload) {
    if (payload?.source !== "agent") return;
    if (imageSafeModeConsentRequestRef.current) return;

    let settings: ProviderModelSettingsDto | undefined;
    try {
      settings = (await providerModelSettings()).settings;
    } catch {
      return;
    }
    if (!settings.imageSafeMode || settings.imageSafeModePromptDismissed) return;
    if (imageSafeModeConsentRequestRef.current) return;

    const choice = await requestImageSafeModeConsent("agent");
    if (choice.action === "dismiss") return;
    if (choice.action === "keep") {
      if (choice.dontAskAgain) void setImageSafeModePromptDismissed(true);
      return;
    }

    try {
      await setImageSafeMode(false);
    } catch (err) {
      setError(messageFromError(err));
      return;
    }
    if (choice.dontAskAgain) void setImageSafeModePromptDismissed(true);
  }

  // `/image <prompt>` renders the generated image inline in the chat as an
  // assistant turn (loader -> image, with view + download), NOT as a composer
  // attachment chip. It creates/uses a real session and the prompt becomes a
  // user turn, but the model is never invoked — the image endpoint IS the whole
  // response (see submitHermesSession's `skipPrompt`). The active text model
  // must already be vision-capable so the generated image can enter context on
  // the follow-up. The image generation model is still resolved server-side
  // from the saved image default.
  async function runImageSlashCommand(
    argument: string,
    commandText: string,
    modelTarget = captureSessionModelTarget(),
    dispatchReservation?: HermesSessionDispatchReservation,
  ) {
    if (creditActionsDisabledReason) {
      setError(creditActionsDisabledReason);
      return;
    }
    const prompt = argument.trim();
    if (!prompt) {
      setError("Type a description after /image to generate an image.");
      return;
    }

    // Busy-gate the consent + generation flow before any async IPC. This keeps
    // a second /image submission from starting while the prompt screen or
    // dialog is pending, but still lets dismiss leave the draft untouched.
    setImportingFiles(true);

    // Pin the image model and safe mode before the paid turn starts: June API's
    // replay ledger hashes them into the requestId's key, so a retry after a
    // settings change must send the values this turn started with or it becomes
    // a second charge. If the settings read fails, leave them unpinned (server
    // resolves live, matching the pre-pinning behavior) and skip consent.
    let settings: ProviderModelSettingsDto | undefined;
    let pinnedModel: string | undefined;
    let pinnedSafeMode: boolean | undefined;
    try {
      const settingsResponse = await providerModelSettings();
      settings = settingsResponse.settings;
      pinnedModel =
        settingsResponse.effectiveSettings?.imageModel || settings.imageModel || undefined;
      pinnedSafeMode = settings.imageSafeMode;
    } catch {
      // Non-fatal: generation proceeds with server-resolved settings.
    }

    if (settings?.imageSafeMode && !settings.imageSafeModePromptDismissed) {
      let mayBeExplicit = false;
      try {
        mayBeExplicit = await imagePromptMayBeExplicit(prompt);
      } catch {
        mayBeExplicit = false;
      }
      if (mayBeExplicit) {
        const choice = await requestImageSafeModeConsent("slash", dispatchReservation);
        if (choice.action === "dismiss") {
          setImportingFiles(false);
          return;
        }
        if (choice.action === "keep") {
          if (choice.dontAskAgain) void setImageSafeModePromptDismissed(true);
          pinnedSafeMode = true;
        } else {
          try {
            await setImageSafeMode(false);
          } catch (err) {
            setImportingFiles(false);
            setError(messageFromError(err));
            return;
          }
          if (choice.dontAskAgain) void setImageSafeModePromptDismissed(true);
          pinnedSafeMode = false;
        }
      }
    }

    if (composerDispatchWasInvalidated(dispatchReservation)) {
      setImportingFiles(false);
      return;
    }

    // The prompt is about to become a user turn — clear the draft up front and,
    // on a fresh session, play the hero teardown so the conversation view takes
    // over while the session is created.
    const heroMode = newSessionModeRef.current;
    if (heroMode) setHeroLeaving(true);
    clearComposerCommandDraft(commandText);
    setError(null);
    // importingFiles already busy-gates the WHOLE flow (consent + session
    // create + generation) via the same flag submit() and the send button check.
    // generatingImage only tailors the placeholder copy once generation starts.
    setGeneratingImage(true);

    let targetSessionId: string | undefined;
    try {
      targetSessionId = await submitHermesSession(prompt, undefined, {
        skipPrompt: true,
        displayContent: prompt,
        titleContent: prompt,
        modelTarget,
        dispatchReservation,
      });
    } catch (err) {
      if (heroMode) setHeroLeaving(false);
      setGeneratingImage(false);
      setImportingFiles(false);
      setError(messageFromError(err));
      return;
    }
    if (!targetSessionId) {
      if (heroMode) setHeroLeaving(false);
      setGeneratingImage(false);
      setImportingFiles(false);
      setError("Could not start an image session. Try again.");
      return;
    }
    const sessionId = targetSessionId;

    // Inject the synthetic user prompt plus running assistant image turn. The
    // slash flow does not call prompt.submit, so these are June-side turns.
    const turnStartedAt = Date.now();
    const turnId = `image:${sessionId}:${turnStartedAt}`;
    const createdAt = new Date(turnStartedAt).toISOString();
    const imageCreatedAt = new Date(turnStartedAt + 1).toISOString();
    const requestId = newImageRequestId();
    setImageTurnsBySession((current) => ({
      ...current,
      [sessionId]: [
        ...(current[sessionId] ?? []),
        ...runningImageSlashTurns({
          id: turnId,
          prompt,
          requestId,
          createdAt,
          imageCreatedAt,
          model: pinnedModel,
          safeMode: pinnedSafeMode,
        }),
      ],
    }));

    // Persist the replay shape BEFORE the paid request starts: if the app
    // exits mid-generation, the restored turn can retry the SAME request id
    // instead of minting a new one (a possibly-settled request would then be
    // billed twice). The success path below overwrites this with the
    // completed turn.
    upsertStoredImageSlashTurn({
      id: turnId,
      sessionId,
      prompt,
      path: "",
      name: "",
      createdAt,
      imageCreatedAt,
      contextPending: false,
      pending: true,
      requestId,
      model: pinnedModel,
      safeMode: pinnedSafeMode,
    });

    await finishImageSlashGeneration({
      sessionId,
      turnId,
      prompt,
      requestId,
      createdAt,
      imageCreatedAt,
      model: pinnedModel,
      safeMode: pinnedSafeMode,
    });
  }

  return {
    finishImageSlashGeneration,
    retryImageSlashTurn,
    requestImageSafeModeConsent,
    resolveImageSafeModeConsent,
    handleAgentImageSafeModeConsentEvent,
    runImageSlashCommand,
  };
}
