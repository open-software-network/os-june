import {
  providerModelSettings,
  imagePromptMayBeExplicit,
  setImageSafeMode,
  setImageSafeModePromptDismissed,
  videoGenerate,
  videoStatus,
  type ProviderModelSettingsDto,
} from "../../lib/tauri";
import { hermesModeFor } from "../../lib/hermes-control-plane";
import { hermesArtifactStore } from "../../lib/hermes-artifact-store";
import { type HermesSessionDispatchReservation } from "../../lib/hermes-session-dispatch-mutex";
import { messageFromError } from "../../lib/errors";
import {
  generateChatVideo,
  newVideoRequestId,
  pollChatVideo,
} from "../../lib/chat-video-generation";
import { type AgentChatPart } from "../../lib/agent-chat-runtime";
import {
  filenameFromWorkspacePath,
  removeStoredVideoSlashTurn,
  runningVideoSlashTurns,
  upsertStoredVideoSlashTurn,
  type PersistedVideoSlashTurn,
} from "./composer/media-slash-persistence";
import type { createVideoSlashActionsDependencies } from "./video-slash-actions-types";

export function createVideoSlashActions(dependencies: createVideoSlashActionsDependencies) {
  const {
    captureSessionModelTarget,
    clearComposerCommandDraft,
    composerDispatchWasInvalidated,
    creditActionsDisabledReason,
    loadFilesystemSnapshot,
    newSessionModeRef,
    requestImageSafeModeConsent,
    setError,
    setGeneratingVideo,
    setHeroLeaving,
    setImportingFiles,
    setVideoTurnsBySession,
    submitHermesSession,
    updateVideoSlashPart,
    videoSlashBaseTurnId,
  } = dependencies;

  async function finishVideoSlashGeneration(input: {
    sessionId: string;
    turnId: string;
    prompt: string;
    requestId: string;
    createdAt: string;
    videoCreatedAt: string;
    model?: string;
    jobId?: string;
  }) {
    const { sessionId, turnId, prompt, requestId, createdAt, videoCreatedAt } = input;
    const assistantTurnId = `${turnId}:assistant`;
    try {
      const result = input.jobId
        ? await pollExistingVideoSlashJob(input)
        : await generateChatVideo(
            prompt,
            {
              startGenerate: async (text, model, nextRequestId, options) => {
                const job = await videoGenerate({
                  prompt: text,
                  model,
                  requestId: nextRequestId,
                  ...options,
                });
                updateVideoSlashPart(sessionId, assistantTurnId, { jobId: job.jobId });
                upsertStoredVideoSlashTurn({
                  id: turnId,
                  sessionId,
                  prompt,
                  path: "",
                  name: "",
                  createdAt,
                  videoCreatedAt,
                  pending: true,
                  requestId,
                  model: input.model,
                  jobId: job.jobId,
                });
                return job;
              },
              pollStatus: videoStatus,
              onProgress: (progress) => {
                updateVideoSlashPart(sessionId, assistantTurnId, {
                  jobId: progress.jobId,
                });
                upsertStoredVideoSlashTurn({
                  id: turnId,
                  sessionId,
                  prompt,
                  path: "",
                  name: "",
                  createdAt,
                  videoCreatedAt,
                  pending: true,
                  requestId,
                  model: input.model,
                  jobId: progress.jobId,
                });
              },
            },
            input.model,
            requestId,
            {},
          );
      if (result.status !== "ok") {
        updateVideoSlashPart(sessionId, assistantTurnId, {
          status: "error",
          error: result.message,
          jobId: result.jobId,
        });
        if (!result.stillRunning) {
          removeStoredVideoSlashTurn(turnId);
        }
        return;
      }
      const name = filenameFromWorkspacePath(result.path, "generated-video.mp4");
      updateVideoSlashPart(sessionId, assistantTurnId, {
        status: "complete",
        path: result.path,
        name,
        model: result.model ?? input.model,
      });
      upsertStoredVideoSlashTurn({
        id: turnId,
        sessionId,
        prompt,
        path: result.path,
        name,
        createdAt,
        videoCreatedAt,
        requestId,
        model: result.model ?? input.model,
        jobId: result.jobId,
        // Hold this turn's context for the video fold: the next real prompt in
        // this session carries it to the model (storedPendingVideoSlashContexts).
        contextPending: true,
      });
      hermesArtifactStore.recordArtifact(
        {
          sessionId,
          kind: "file",
          action: "created",
          path: result.path,
          displayName: name,
          previewAvailable: false,
        },
        hermesModeFor(sessionId),
      );
      void loadFilesystemSnapshot();
    } catch (err) {
      updateVideoSlashPart(sessionId, assistantTurnId, {
        status: "error",
        error: messageFromError(err),
      });
    } finally {
      setGeneratingVideo(false);
      setImportingFiles(false);
    }
  }

  async function pollExistingVideoSlashJob(input: {
    sessionId: string;
    turnId: string;
    prompt: string;
    requestId: string;
    createdAt: string;
    videoCreatedAt: string;
    model?: string;
    jobId?: string;
  }) {
    if (!input.jobId) {
      return { status: "error" as const, message: "Generation was interrupted." };
    }
    // Poll the existing job with the full loop (not a single shot) so a retry
    // follows it to completion, re-attaching to the same server-side job.
    return pollChatVideo(input.jobId, {
      pollStatus: videoStatus,
      onProgress: (progress) => {
        updateVideoSlashPart(input.sessionId, `${input.turnId}:assistant`, {
          jobId: progress.jobId,
        });
        upsertStoredVideoSlashTurn({
          id: input.turnId,
          sessionId: input.sessionId,
          prompt: input.prompt,
          path: "",
          name: "",
          createdAt: input.createdAt,
          videoCreatedAt: input.videoCreatedAt,
          pending: true,
          requestId: input.requestId,
          model: input.model,
          jobId: input.jobId,
        });
      },
    });
  }

  // Resume a `/video` turn whose poll loop was lost (app crash, restart, or dev
  // hot-reload). The server job keeps running, so re-attach with the SAME poll
  // loop and follow it to completion instead of a single shot — the user gets
  // the video without a new billable generation, and never has to hit "Try
  // again" just because the app closed mid-render.
  async function resumePendingVideoSlashTurn(turn: PersistedVideoSlashTurn) {
    if (!turn.jobId) return;
    const jobId = turn.jobId;
    const assistantTurnId = `${turn.id}:assistant`;
    const result = await pollChatVideo(jobId, {
      pollStatus: videoStatus,
      onProgress: (progress) => {
        updateVideoSlashPart(turn.sessionId, assistantTurnId, {
          status: "running",
          jobId: progress.jobId,
        });
        upsertStoredVideoSlashTurn({
          ...turn,
          pending: true,
        });
      },
    });
    if (result.status === "ok") {
      const name = filenameFromWorkspacePath(result.path, "generated-video.mp4");
      updateVideoSlashPart(turn.sessionId, assistantTurnId, {
        status: "complete",
        path: result.path,
        name,
        model: result.model ?? turn.model,
      });
      upsertStoredVideoSlashTurn({
        ...turn,
        pending: false,
        path: result.path,
        name,
        model: result.model ?? turn.model,
        // Fold this turn's context into the next prompt, same as a live finish.
        contextPending: true,
      });
      hermesArtifactStore.recordArtifact(
        {
          sessionId: turn.sessionId,
          kind: "file",
          action: "created",
          path: result.path,
          displayName: name,
          previewAvailable: false,
        },
        hermesModeFor(turn.sessionId),
      );
      void loadFilesystemSnapshot();
      return;
    }
    // Budget exhausted while the job was still processing: it lives on the
    // server, so keep the turn pending (its stored jobId) and leave the loader
    // up — the next app launch resumes this exact loop. Only a real Venice
    // failure or a poll error is terminal and surfaces as retryable.
    if (result.stillRunning) {
      updateVideoSlashPart(turn.sessionId, assistantTurnId, {
        status: "running",
        jobId,
      });
      return;
    }
    updateVideoSlashPart(turn.sessionId, assistantTurnId, {
      status: "error",
      error: result.message,
      jobId,
    });
    removeStoredVideoSlashTurn(turn.id);
  }

  async function retryVideoSlashTurn(
    sessionId: string,
    assistantTurnId: string,
    part: Extract<AgentChatPart, { type: "video" }>,
  ) {
    if (creditActionsDisabledReason && !part.jobId) {
      setError(creditActionsDisabledReason);
      return;
    }
    if (part.status !== "error" || !part.requestId) return;
    const now = new Date().toISOString();
    setError(null);
    setImportingFiles(true);
    setGeneratingVideo(true);
    updateVideoSlashPart(sessionId, assistantTurnId, {
      status: "running",
      error: undefined,
    });
    await finishVideoSlashGeneration({
      sessionId,
      turnId: videoSlashBaseTurnId(assistantTurnId),
      prompt: part.prompt,
      requestId: part.requestId,
      createdAt: part.userCreatedAt ?? now,
      videoCreatedAt: part.videoCreatedAt ?? now,
      model: part.model,
      jobId: part.jobId,
    });
  }

  async function runVideoSlashCommand(
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
      setError("Type a description after /video to generate a video.");
      return;
    }

    // Busy-gate the consent + generation flow before any async IPC, mirroring
    // /image: a second submission can't start while the prompt screen or
    // consent dialog is pending, and dismiss leaves the draft untouched.
    setImportingFiles(true);

    // Pin the video model before the paid turn starts (same replay-ledger
    // rationale as /image). Safe mode is read alongside but never pinned into
    // the request: video requests carry no safeMode field (Venice cannot blur
    // video), so the value only gates the consent dialog below.
    let settings: ProviderModelSettingsDto | undefined;
    let pinnedModel: string | undefined;
    try {
      const settingsResponse = await providerModelSettings();
      settings = settingsResponse.settings;
      pinnedModel =
        settingsResponse.effectiveSettings?.videoModel || settings.videoModel || undefined;
    } catch {
      // Non-fatal: generation proceeds with server-resolved settings.
    }

    // Unlike /image, the screen runs even after "don't ask again": for video
    // the dialog is the enforcement point (there is no blur to fall back to),
    // so an explicit prompt with safe mode on must never generate silently.
    if (settings?.imageSafeMode) {
      let mayBeExplicit = false;
      try {
        mayBeExplicit = await imagePromptMayBeExplicit(prompt);
      } catch {
        mayBeExplicit = false;
      }
      if (mayBeExplicit) {
        if (settings.imageSafeModePromptDismissed) {
          // The user opted out of the dialog, not out of safe mode: skip the
          // generation with a notice instead of asking again.
          setImportingFiles(false);
          setError(
            "Safe mode is on, so this video was skipped. Turn safe mode off in Settings to generate it.",
          );
          return;
        }
        const choice = await requestImageSafeModeConsent("video-slash", dispatchReservation);
        if (choice.action === "dismiss") {
          setImportingFiles(false);
          return;
        }
        if (choice.action === "keep") {
          // "Skip this video": no blurred fallback exists for video, so safe
          // mode on means the generation is skipped (the dialog says so).
          if (choice.dontAskAgain) void setImageSafeModePromptDismissed(true);
          setImportingFiles(false);
          return;
        }
        try {
          await setImageSafeMode(false);
        } catch (err) {
          setImportingFiles(false);
          setError(messageFromError(err));
          return;
        }
        if (choice.dontAskAgain) void setImageSafeModePromptDismissed(true);
      }
    }

    if (composerDispatchWasInvalidated(dispatchReservation)) {
      setImportingFiles(false);
      return;
    }

    const heroMode = newSessionModeRef.current;
    if (heroMode) setHeroLeaving(true);
    clearComposerCommandDraft(commandText);
    setError(null);
    setGeneratingVideo(true);

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
      setGeneratingVideo(false);
      setImportingFiles(false);
      setError(messageFromError(err));
      return;
    }
    if (!targetSessionId) {
      if (heroMode) setHeroLeaving(false);
      setGeneratingVideo(false);
      setImportingFiles(false);
      setError("Could not start a video session. Try again.");
      return;
    }
    const sessionId = targetSessionId;

    const turnStartedAt = Date.now();
    const turnId = `video:${sessionId}:${turnStartedAt}`;
    const createdAt = new Date(turnStartedAt).toISOString();
    const videoCreatedAt = new Date(turnStartedAt + 1).toISOString();
    const requestId = newVideoRequestId();

    setVideoTurnsBySession((current) => ({
      ...current,
      [sessionId]: [
        ...(current[sessionId] ?? []),
        ...runningVideoSlashTurns({
          id: turnId,
          prompt,
          requestId,
          createdAt,
          videoCreatedAt,
          model: pinnedModel,
        }),
      ],
    }));

    upsertStoredVideoSlashTurn({
      id: turnId,
      sessionId,
      prompt,
      path: "",
      name: "",
      createdAt,
      videoCreatedAt,
      pending: true,
      requestId,
      model: pinnedModel,
    });

    await finishVideoSlashGeneration({
      sessionId,
      turnId,
      prompt,
      requestId,
      createdAt,
      videoCreatedAt,
      model: pinnedModel,
    });
  }

  return {
    finishVideoSlashGeneration,
    pollExistingVideoSlashJob,
    resumePendingVideoSlashTurn,
    retryVideoSlashTurn,
    runVideoSlashCommand,
  };
}
