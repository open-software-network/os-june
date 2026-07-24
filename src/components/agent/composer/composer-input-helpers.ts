import {
  USER_ATTACHMENT_PROMPT_MARKER,
  isGeneratedVideoFilename,
  type AgentChatTurn,
} from "../../../lib/agent-chat-runtime";
import { modelSupportsTools } from "../../../lib/model-privacy";
import type { VeniceModelDto } from "../../../lib/tauri";
import type { AgentArtifact } from "../chat-turns/AgentArtifactPanel";
import type { AgentAttachment } from "../agent-workspace-models";
import { workspaceRelativeArtifactPath } from "../artifact-index";
import type { ReportCategory } from "./reportCategory";

const COMPOSER_TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;

export type ComposerInputSizeWarning = {
  inputSignature: string;
  signature: string;
  estimatedTokens: number;
  contextLimit: number;
  modelName: string;
  switchModel?: VeniceModelDto;
};

export function composerInputSignatureFor({
  message,
  category,
  attachments,
  model,
}: {
  message: string;
  category: ReportCategory | null;
  attachments: AgentAttachment[];
  model?: VeniceModelDto;
}) {
  const attachmentSignature = composerAttachmentSignature(attachments);
  return [
    model?.id ?? "",
    positiveContextTokens(model?.contextTokens) ?? "",
    category ?? "",
    composerInputHash(`${message}\n${attachmentSignature}`),
  ].join(":");
}

export function oversizedComposerInputWarning({
  content,
  inputSignature,
  attachments,
  model,
  models,
}: {
  content: string;
  inputSignature: string;
  attachments: AgentAttachment[];
  model?: VeniceModelDto;
  models: VeniceModelDto[];
}): ComposerInputSizeWarning | null {
  const contextLimit = positiveContextTokens(model?.contextTokens);
  if (!contextLimit) return null;

  // The composer only has attachment metadata here. Treat file bytes as a
  // conservative character proxy so large pending files still get a warning.
  const attachmentCharacterProxy = attachments.reduce(
    (total, attachment) => total + nonNegativeAttachmentSize(attachment.size),
    0,
  );
  const estimatedTokens = Math.ceil(
    (content.length + attachmentCharacterProxy) / COMPOSER_TOKEN_ESTIMATE_CHARS_PER_TOKEN,
  );
  if (estimatedTokens <= contextLimit) return null;

  const signature = [
    inputSignature,
    model?.id ?? "",
    contextLimit,
    estimatedTokens,
    composerInputHash(content),
  ].join(":");

  return {
    inputSignature,
    signature,
    estimatedTokens,
    contextLimit,
    modelName: model?.name?.trim() || "the selected model",
    switchModel: largerContextModel({
      currentModel: model,
      estimatedTokens,
      currentContextLimit: contextLimit,
      models,
    }),
  };
}

function composerAttachmentSignature(attachments: AgentAttachment[]) {
  return attachments
    .map((attachment) =>
      [
        attachment.id,
        attachment.path,
        attachment.name,
        attachment.size ?? "",
        attachment.attach.status,
      ].join("|"),
    )
    .join("\n");
}

function positiveContextTokens(value?: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function nonNegativeAttachmentSize(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

function largerContextModel({
  currentModel,
  estimatedTokens,
  currentContextLimit,
  models,
}: {
  currentModel?: VeniceModelDto;
  estimatedTokens: number;
  currentContextLimit: number;
  models: VeniceModelDto[];
}) {
  const candidates = models
    .filter((model) => model.id !== currentModel?.id)
    .filter((model) => modelSupportsTools(model))
    .map((model) => ({ model, contextTokens: positiveContextTokens(model.contextTokens) }))
    .filter(
      (item): item is { model: VeniceModelDto; contextTokens: number } =>
        item.contextTokens !== undefined && item.contextTokens > currentContextLimit,
    );
  const sufficient = candidates
    .filter((item) => item.contextTokens >= estimatedTokens)
    .sort((a, b) => a.contextTokens - b.contextTokens);
  if (sufficient.length) return sufficient[0].model;
  return candidates.sort((a, b) => b.contextTokens - a.contextTokens)[0]?.model;
}

function composerInputHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function formatComposerTokenCount(value: number) {
  return value.toLocaleString();
}

export function promptWithAttachments(message: string, attachments: AgentAttachment[]): string {
  if (!attachments.length) return message;
  return [
    message || "Use the attached file(s).",
    "",
    USER_ATTACHMENT_PROMPT_MARKER,
    "Attached files copied into the June workspace:",
    ...attachments.map(
      (attachment) =>
        `- ${attachment.name} (${attachment.rootLabel}): ${attachmentPromptPath(attachment.path)}`,
    ),
    "",
    "Use these file paths when inspecting or operating on the files.",
  ].join("\n");
}

export function unsupportedImageInputPrompt({
  displayContent,
  imageNames,
  modelName,
  runtimeContent,
}: {
  displayContent: string;
  imageNames: string[];
  modelName?: string;
  runtimeContent: string;
}) {
  const modelLabel = modelName?.trim() || "The selected model";
  return [
    displayContent,
    "",
    "--- Attached Context ---",
    `${modelLabel} does not support image input in June.`,
    "The user attached image file(s), but this model cannot read their visual contents.",
    imageNames.length ? `Attached image file(s): ${imageNames.join(", ")}.` : undefined,
    "Do not call vision_analyze, image tools, shell, filesystem tools, or any other tool to inspect the image files.",
    "Reply directly and briefly. Say that you cannot view the attached image with the current model, then ask the user to describe the image or paste the relevant text. If they expected the image to be readable, suggest choosing a model with image support and sending the image again.",
    runtimeContent !== displayContent
      ? ["", "Original routed prompt:", runtimeContent].join("\n")
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function attachmentPromptPath(path: string) {
  return workspaceRelativeArtifactPath(path);
}

// The inline media renderer owns generated image and video cards, so
// assignArtifactsToTurns deliberately excludes their workspace files. The
// Files panel still needs that path-backed media: collect it beside the ordinary
// per-turn artifacts, preserving conversation order and listing each file once.
export function surfacedArtifactsFromTurns(
  turns: AgentChatTurn[],
  artifactsByTurn: Map<string, AgentArtifact[]>,
  availableArtifacts: AgentArtifact[],
): AgentArtifact[] {
  const surfaced: AgentArtifact[] = [];
  const surfacedPaths = new Set<string>();
  const surfacedMediaAliases = new Map<string, string>();

  function addArtifact(artifact: AgentArtifact) {
    if (surfacedPaths.has(artifact.path)) return;
    surfacedPaths.add(artifact.path);
    surfaced.push(artifact);
  }

  for (const turn of turns) {
    for (const artifact of artifactsByTurn.get(turn.id) ?? []) addArtifact(artifact);
    for (const part of turn.parts) {
      if ((part.type !== "image" && part.type !== "video") || part.status !== "complete") {
        continue;
      }
      const mediaPath = part.path?.trim();
      if (!mediaPath) continue;
      const aliases =
        part.type === "image"
          ? generatedImagePathAliases(mediaPath, part.name)
          : generatedVideoPathAliases(mediaPath);
      const matchingArtifacts = availableArtifacts.filter(
        (artifact) => artifact.path === mediaPath,
      );
      let matchedArtifact = matchingArtifacts.length === 1 ? matchingArtifacts[0] : undefined;
      if (!matchedArtifact && part.type === "video" && isBareMediaPath(mediaPath)) {
        const aliasMatches = availableArtifacts.filter((artifact) =>
          generatedVideoPathAliases(artifact.path).some((alias) => aliases.includes(alias)),
        );
        if (aliasMatches.length === 1) matchedArtifact = aliasMatches[0];
      }
      const artifact =
        matchedArtifact ??
        ({
          name:
            part.name?.trim() || (part.type === "image" ? "Generated image" : "Generated video"),
          path: mediaPath,
          rootLabel: "Workspace",
        } satisfies AgentArtifact);
      const existingPath = aliases
        .map((alias) => surfacedMediaAliases.get(alias))
        .find((path) => path !== undefined);
      if (existingPath) {
        // A bare MEDIA reference can arrive before the filesystem snapshot or
        // a later absolute MEDIA reference. Keep the canonical path so Files
        // preview/download actions reach the native validator successfully.
        // Only video aliases are strict generated-video-<hex> filenames (1:1
        // with files); image aliases can derive from tool-supplied display
        // names, so two different files can be alias-equal — never upgrade
        // (and erase) a surfaced image row on that basis.
        let canonicalPath = existingPath;
        if (
          part.type === "video" &&
          isBareMediaPath(existingPath) &&
          !isBareMediaPath(artifact.path)
        ) {
          const index = surfaced.findIndex((item) => item.path === existingPath);
          if (index >= 0) {
            if (surfacedPaths.has(artifact.path)) surfaced.splice(index, 1);
            else {
              surfaced[index] = artifact;
              surfacedPaths.add(artifact.path);
            }
            surfacedPaths.delete(existingPath);
            for (const [alias, path] of surfacedMediaAliases) {
              if (path === existingPath) surfacedMediaAliases.set(alias, artifact.path);
            }
            canonicalPath = artifact.path;
          }
        }
        // Register this part's own aliases against the surviving row so a later
        // bare reference through an unregistered alias doesn't push a duplicate.
        for (const alias of aliases) surfacedMediaAliases.set(alias, canonicalPath);
        continue;
      }
      addArtifact(artifact);
      for (const alias of aliases) surfacedMediaAliases.set(alias, artifact.path);
    }
  }

  return surfaced;
}

function isBareMediaPath(path: string): boolean {
  return !path.replaceAll("\\", "/").includes("/");
}

export function generatedImagePathAliases(path: string, displayName?: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  if (!isBareMediaPath(path) && !/\/(?:image_cache|images)\//i.test(normalized)) return [];
  const aliases = new Set<string>();
  const pathName = normalized.split("/").at(-1);
  if (pathName) aliases.add(normalizedGeneratedImageName(pathName));
  const name = displayName?.trim();
  if (name && (/\.june-source-[^.]+(?=\.[^.]+$)/i.test(name) || /^generated-image-/i.test(name))) {
    aliases.add(normalizedGeneratedImageName(name));
  }
  return [...aliases];
}

function normalizedGeneratedImageName(name: string): string {
  return name.replace(/\.june-source-[^.]+(?=\.[^.]+$)/i, "").toLowerCase();
}

function generatedVideoPathAliases(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  if (!isBareMediaPath(path) && !/\/(?:video_cache|videos)\//i.test(normalized)) return [];
  const name = normalized.split("/").at(-1);
  return name && isGeneratedVideoFilename(name) ? [name.toLowerCase()] : [];
}
