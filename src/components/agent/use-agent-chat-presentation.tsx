import { useCallback } from "react";
import { toast } from "../ui/Toaster";
import { downloadHermesBridgeFile, revealPath } from "../../lib/tauri";
import {
  // The store's record shape collides by name with this file's local
  // `AgentArtifact` (the file-viewer card), so alias it.
  type AgentArtifact as TimelineArtifact,
} from "../../lib/hermes-artifact-store";
import { messageFromError } from "../../lib/errors";
import {
  buildAgentChatTurns,
  buildHermesSessionChatTurns,
  type AgentChatPart,
} from "../../lib/agent-chat-runtime";
import { upstreamProviderRecoveryIds } from "../../lib/upstream-provider-recovery";
import { mergeThinkingTurns } from "./chat-turns/TranscriptViews";
import { type AgentArtifact } from "./chat-turns/AgentArtifactPanel";
import {
  assignArtifactsToTurns,
  surfacedArtifactsFromTurns,
} from "./composer/composer-input-helpers";
import { DownloadToastMessage, ensureDownloadFileExtension } from "./agent-workspace-support";
import type { UseAgentChatPresentationDependencies } from "./use-agent-chat-presentation-types";

export function useAgentChatPresentation(dependencies: UseAgentChatPresentationDependencies) {
  const {
    DOWNLOAD_TOAST_ID,
    chatArtifacts,
    devArtifacts,
    imageTurnsBySession,
    liveEvents,
    selectedHermesMessages,
    selectedHermesSessionId,
    selectedHermesSessionIdRef,
    selectedTask,
    setArtifactPanel,
    setError,
    setThinkingOpenByKey,
    thinkingOpenByKey,
    videoTurnsBySession,
  } = dependencies;

  const hermesTurns = selectedHermesSessionId
    ? // Merge client-synthesized slash overlays with gateway-derived turns,
      // ordered by createdAt. Array.sort is stable, and media turn timestamps
      // are minted strictly after their user prompts, so results render below
      // the prompts that produced them.
      [
        ...mergeThinkingTurns(
          buildHermesSessionChatTurns(
            selectedHermesMessages,
            liveEvents[selectedHermesSessionId] ?? [],
          ),
        ),
        ...(imageTurnsBySession[selectedHermesSessionId] ?? []),
        ...(videoTurnsBySession[selectedHermesSessionId] ?? []),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : [];
  const upstreamFailureRecoveryIds = upstreamProviderRecoveryIds(hermesTurns);
  const taskTurns = selectedTask
    ? mergeThinkingTurns(
        buildAgentChatTurns(
          selectedTask.messages,
          selectedTask.toolEvents,
          liveEvents[selectedTask.id] ?? [],
        ),
      )
    : [];
  const turnArtifacts = assignArtifactsToTurns(
    selectedHermesSessionId ? hermesTurns : taskTurns,
    chatArtifacts,
  );
  const surfacedConversationArtifacts = surfacedArtifactsFromTurns(
    selectedHermesSessionId ? hermesTurns : taskTurns,
    turnArtifacts,
    chatArtifacts,
  );
  const activeThinkingKey = selectedHermesSessionId
    ? `session:${selectedHermesSessionId}:active`
    : selectedTask
      ? `task:${selectedTask.id}:active`
      : undefined;
  const thinkingOpen = useCallback(
    (key: string) => thinkingOpenByKey[key] ?? false,
    [thinkingOpenByKey],
  );
  const setThinkingOpen = useCallback((key: string, open: boolean) => {
    setThinkingOpenByKey((current) =>
      current[key] === open ? current : { ...current, [key]: open },
    );
  }, []);
  // Every file the conversation has surfaced, in turn order — the session
  // bar's files button keeps them reachable after their cards scroll away.
  const surfacedArtifacts = surfacedConversationArtifacts.concat(devArtifacts);
  const downloadPathBackedArtifact = (path: string, displayName: string) => {
    const requestSessionId = selectedHermesSessionIdRef.current;
    void downloadHermesBridgeFile(path)
      .then((destination) => {
        if (selectedHermesSessionIdRef.current === requestSessionId) {
          toast.success(<DownloadToastMessage action="Downloaded" fileName={displayName} />, {
            id: DOWNLOAD_TOAST_ID,
            action: {
              label: "Show file",
              onClick: () => void revealPath(destination),
            },
          });
        }
      })
      .catch((err: unknown) => {
        setError(messageFromError(err), { sessionId: requestSessionId ?? null });
      });
  };
  const downloadArtifact = (artifact: AgentArtifact) => {
    downloadPathBackedArtifact(artifact.path, artifact.name);
  };
  const openArtifact = (artifact: AgentArtifact) => setArtifactPanel({ view: "file", artifact });

  // A `/image` result reuses the artifact view/download flow: download saves the
  // imported workspace file; "open" enlarges it in the same file viewer any
  // generated file uses. The image part carries its bytes inline for the
  // thumbnail, but the affordances key off the imported path on disk.
  const downloadGeneratedImage = (part: Extract<AgentChatPart, { type: "image" }>) => {
    // A `/image` result has an imported workspace file; save it through the
    // bridge (native save dialog). A tool-produced image (june_image MCP) has
    // no June-workspace path — its bytes live only in the inline data url, so
    // save those directly via an anchor download.
    if (part.path) {
      downloadPathBackedArtifact(part.path, part.name?.trim() || "Generated image");
      return;
    }
    if (part.dataUrl) {
      const requestSessionId = selectedHermesSessionIdRef.current;
      const fileName = ensureDownloadFileExtension(
        part.name?.trim() || "generated-image.png",
        "png",
      );
      const link = document.createElement("a");
      link.href = part.dataUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      if (selectedHermesSessionIdRef.current === requestSessionId) {
        toast(<DownloadToastMessage action="Download started" fileName={fileName} />, {
          id: DOWNLOAD_TOAST_ID,
        });
      }
    }
  };
  const openGeneratedImage = (part: Extract<AgentChatPart, { type: "image" }>) => {
    if (!part.path) return;
    openArtifact({
      name: part.name?.trim() || "Generated image",
      path: part.path,
      rootLabel: "Workspace",
    });
  };
  const downloadGeneratedVideo = (part: Extract<AgentChatPart, { type: "video" }>) => {
    if (!part.path) return;
    downloadPathBackedArtifact(part.path, part.name?.trim() || "Generated video");
  };

  // Feature 14: open an artifact from the drawer's timeline. The timeline's
  // record (hermes-artifact-store's AgentArtifact) is a different, richer shape
  // than the file-viewer's local AgentArtifact, so adapt it onto the EXISTING
  // preview flow rather than building a second viewer: a filesystem-backed
  // artifact opens in the same `AgentArtifactPanel` (which fetches via
  // hermes_bridge_file_preview / _file_text), and a remote url opens in the
  // browser. A failed access has nothing to preview, so it stays inert.
  const openTimelineArtifact = useCallback((artifact: TimelineArtifact) => {
    if (artifact.action === "failed") return;
    if (artifact.kind === "url") {
      if (artifact.path) window.open(artifact.path, "_blank", "noopener");
      return;
    }
    if (!artifact.path) return;
    setArtifactPanel({
      view: "file",
      artifact: {
        name: artifact.displayName ?? artifact.path,
        path: artifact.path,
        rootLabel: artifact.mode === "unrestricted" ? "Local" : "Workspace",
        size: null,
      },
    });
  }, []);

  return {
    hermesTurns,
    upstreamFailureRecoveryIds,
    taskTurns,
    turnArtifacts,
    activeThinkingKey,
    thinkingOpen,
    setThinkingOpen,
    surfacedArtifacts,
    downloadArtifact,
    openArtifact,
    downloadGeneratedImage,
    openGeneratedImage,
    downloadGeneratedVideo,
    openTimelineArtifact,
  };
}
