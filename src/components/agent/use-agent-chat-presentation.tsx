import { useCallback, useMemo, useRef } from "react";
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
  type AgentChatTurn,
} from "../../lib/agent-chat-runtime";
import type { JuneHermesEvent } from "../../lib/hermes-control-plane";
import { upstreamProviderRecoveryIds } from "../../lib/upstream-provider-recovery";
import { mergeThinkingTurns } from "./chat-turns/TranscriptViews";
import { type AgentArtifact } from "./chat-turns/AgentArtifactPanel";
import { surfacedArtifactsFromTurns } from "./composer/composer-input-helpers";
import { DownloadToastMessage, ensureDownloadFileExtension } from "./agent-workspace-support";
import type { UseAgentChatPresentationDependencies } from "./use-agent-chat-presentation-types";

const EMPTY_CHAT_TURNS: AgentChatTurn[] = [];
const EMPTY_HERMES_EVENTS: JuneHermesEvent[] = [];

function shallowRecordEqual(left: object, right: object) {
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;
  return leftKeys.every((key) => {
    const leftValue = leftRecord[key];
    const rightValue = rightRecord[key];
    if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
      return (
        leftValue.length === rightValue.length &&
        leftValue.every((value, index) => Object.is(value, rightValue[index]))
      );
    }
    return Object.is(leftValue, rightValue);
  });
}

function agentChatTurnEqual(left: AgentChatTurn, right: AgentChatTurn) {
  return (
    left.id === right.id &&
    left.branchMessageId === right.branchMessageId &&
    left.role === right.role &&
    left.createdAt === right.createdAt &&
    left.status === right.status &&
    left.isScheduledRun === right.isScheduledRun &&
    left.parts.length === right.parts.length &&
    left.parts.every((part, index) => {
      const rightPart = right.parts[index];
      return (
        rightPart !== undefined &&
        part.type === rightPart.type &&
        shallowRecordEqual(part, rightPart)
      );
    })
  );
}

/** Keeps unchanged rows referentially stable across a rebuilt live transcript. */
function useStableAgentChatTurns(nextTurns: AgentChatTurn[]) {
  const previousRef = useRef<AgentChatTurn[]>([]);
  const previous = previousRef.current;
  const previousById = new Map(previous.map((turn) => [turn.id, turn]));
  const stabilized = nextTurns.map((turn) => {
    const prior = previousById.get(turn.id);
    return prior && agentChatTurnEqual(prior, turn) ? prior : turn;
  });
  const result =
    previous.length === stabilized.length &&
    previous.every((turn, index) => turn === stabilized[index])
      ? previous
      : stabilized;
  previousRef.current = result;
  return result;
}

function artifactListsEqual(left: AgentArtifact[], right: AgentArtifact[]) {
  return left.length === right.length && left.every((artifact, index) => artifact === right[index]);
}

function useStableMapValues<Key, Value>(
  next: Map<Key, Value>,
  valuesEqual: (left: Value, right: Value) => boolean,
) {
  const previousRef = useRef(new Map<Key, Value>());
  const previous = previousRef.current;
  const stabilized = new Map<Key, Value>();
  for (const [key, value] of next) {
    const prior = previous.get(key);
    stabilized.set(key, prior !== undefined && valuesEqual(prior, value) ? prior : value);
  }
  const result =
    previous.size === stabilized.size &&
    [...previous].every(([key, value]) => stabilized.get(key) === value)
      ? previous
      : stabilized;
  previousRef.current = result;
  return result;
}

export function useAgentChatPresentation(dependencies: UseAgentChatPresentationDependencies) {
  const {
    DOWNLOAD_TOAST_ID,
    artifactIndex,
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

  const selectedHermesLiveEvents = selectedHermesSessionId
    ? (liveEvents[selectedHermesSessionId] ?? EMPTY_HERMES_EVENTS)
    : EMPTY_HERMES_EVENTS;
  const selectedImageTurns = selectedHermesSessionId
    ? (imageTurnsBySession[selectedHermesSessionId] ?? EMPTY_CHAT_TURNS)
    : EMPTY_CHAT_TURNS;
  const selectedVideoTurns = selectedHermesSessionId
    ? (videoTurnsBySession[selectedHermesSessionId] ?? EMPTY_CHAT_TURNS)
    : EMPTY_CHAT_TURNS;
  const builtHermesTurns = useMemo(
    () =>
      selectedHermesSessionId
        ? // Merge client-synthesized slash overlays with gateway-derived turns,
          // ordered by createdAt. Array.sort is stable, and media turn timestamps
          // are minted strictly after their user prompts, so results render below
          // the prompts that produced them.
          [
            ...mergeThinkingTurns(
              buildHermesSessionChatTurns(selectedHermesMessages, selectedHermesLiveEvents),
            ),
            ...selectedImageTurns,
            ...selectedVideoTurns,
          ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        : EMPTY_CHAT_TURNS,
    [
      selectedHermesLiveEvents,
      selectedHermesMessages,
      selectedHermesSessionId,
      selectedImageTurns,
      selectedVideoTurns,
    ],
  );
  const hermesTurns = useStableAgentChatTurns(builtHermesTurns);
  const upstreamFailureRecoveryIds = useStableMapValues(
    upstreamProviderRecoveryIds(hermesTurns),
    Object.is,
  );
  const selectedTaskLiveEvents = selectedTask
    ? (liveEvents[selectedTask.id] ?? EMPTY_HERMES_EVENTS)
    : EMPTY_HERMES_EVENTS;
  const builtTaskTurns = useMemo(
    () =>
      selectedTask
        ? mergeThinkingTurns(
            buildAgentChatTurns(
              selectedTask.messages,
              selectedTask.toolEvents,
              selectedTaskLiveEvents,
            ),
          )
        : EMPTY_CHAT_TURNS,
    [selectedTask, selectedTaskLiveEvents],
  );
  const taskTurns = useStableAgentChatTurns(builtTaskTurns);
  const presentedTurns = selectedHermesSessionId ? hermesTurns : taskTurns;
  const turnArtifacts = useStableMapValues(
    useMemo(
      () => artifactIndex.assignArtifactsToTurns(presentedTurns),
      [artifactIndex, chatArtifacts, presentedTurns],
    ),
    artifactListsEqual,
  );
  const surfacedConversationArtifacts = useMemo(
    () => surfacedArtifactsFromTurns(presentedTurns, turnArtifacts, chatArtifacts),
    [chatArtifacts, presentedTurns, turnArtifacts],
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
  const setThinkingOpen = useCallback(
    (key: string, open: boolean) => {
      setThinkingOpenByKey((current) =>
        current[key] === open ? current : { ...current, [key]: open },
      );
    },
    [setThinkingOpenByKey],
  );
  // Every file the conversation has surfaced, in turn order — the session
  // bar's files button keeps them reachable after their cards scroll away.
  const surfacedArtifacts = useMemo(
    () => surfacedConversationArtifacts.concat(devArtifacts),
    [devArtifacts, surfacedConversationArtifacts],
  );
  const downloadPathBackedArtifact = useCallback(
    (path: string, displayName: string) => {
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
    },
    [DOWNLOAD_TOAST_ID, selectedHermesSessionIdRef, setError],
  );
  const downloadArtifact = useCallback(
    (artifact: AgentArtifact) => {
      downloadPathBackedArtifact(artifact.path, artifact.name);
    },
    [downloadPathBackedArtifact],
  );
  const openArtifact = useCallback(
    (artifact: AgentArtifact) => setArtifactPanel({ view: "file", artifact }),
    [setArtifactPanel],
  );

  // A `/image` result reuses the artifact view/download flow: download saves the
  // imported workspace file; "open" enlarges it in the same file viewer any
  // generated file uses. The image part carries its bytes inline for the
  // thumbnail, but the affordances key off the imported path on disk.
  const downloadGeneratedImage = useCallback(
    (part: Extract<AgentChatPart, { type: "image" }>) => {
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
    },
    [DOWNLOAD_TOAST_ID, downloadPathBackedArtifact, selectedHermesSessionIdRef],
  );
  const openGeneratedImage = useCallback(
    (part: Extract<AgentChatPart, { type: "image" }>) => {
      if (!part.path) return;
      openArtifact({
        name: part.name?.trim() || "Generated image",
        path: part.path,
        rootLabel: "Workspace",
      });
    },
    [openArtifact],
  );
  const downloadGeneratedVideo = useCallback(
    (part: Extract<AgentChatPart, { type: "video" }>) => {
      if (!part.path) return;
      downloadPathBackedArtifact(part.path, part.name?.trim() || "Generated video");
    },
    [downloadPathBackedArtifact],
  );

  // Feature 14: open an artifact from the drawer's timeline. The timeline's
  // record (hermes-artifact-store's AgentArtifact) is a different, richer shape
  // than the file-viewer's local AgentArtifact, so adapt it onto the EXISTING
  // preview flow rather than building a second viewer: a filesystem-backed
  // artifact opens in the same `AgentArtifactPanel` (which fetches via
  // hermes_bridge_file_preview / _file_text), and a remote url opens in the
  // browser. A failed access has nothing to preview, so it stays inert.
  const openTimelineArtifact = useCallback(
    (artifact: TimelineArtifact) => {
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
    },
    [setArtifactPanel],
  );

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
