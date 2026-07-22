import { getHermesBridgeSkill } from "../../../lib/tauri";
import { type HermesSessionDispatchReservation } from "../../../lib/hermes-session-dispatch-mutex";
import {
  explicitSkillInvocationPrompt,
  isPathLikeSlashToken,
  parseSkillSlashCommands,
  parseSkillSlashCommandTokens,
  resolveSkillSlashCommands,
  skillDocumentLookupName,
  skillSlashResolutionError,
} from "../../../lib/skill-slash-commands";
import { parseBuiltinComposerSlashCommand } from "../../../lib/agent-composer-slash-commands";
import { IMAGE_GENERATION_ENABLED, VIDEO_GENERATION_ENABLED } from "../../../lib/feature-flags";
import type { AgentAttachment } from "../agent-workspace-models";
import {
  type CapturedSessionModelTarget,
  type PreparedComposerSubmission,
} from "./follow-up-queue";
import { promptWithAttachments } from "./composer-input-helpers";
import {
  commandTokensForResolutions,
  isResolvedSkillSlashResolution,
} from "../agent-workspace-support";
import type { CreateComposerPreparationDependencies } from "./composer-preparation-types";

export function createComposerPreparation(dependencies: CreateComposerPreparationDependencies) {
  const {
    categoryRef,
    loadSkillCommands,
    runFileSlashCommand,
    runImageSlashCommand,
    runModelSlashCommand,
    runVideoSlashCommand,
    setError,
  } = dependencies;

  async function prepareComposerSubmission(
    message: string,
    messageAttachments: AgentAttachment[],
  ): Promise<PreparedComposerSubmission> {
    const parsed = parseSkillSlashCommands(message);
    const commandTokens = commandTokensForResolutions(
      parsed.commandNames,
      parseSkillSlashCommandTokens(message),
    );
    if (!parsed.commandNames.length) {
      const content = promptWithAttachments(message, messageAttachments);
      return {
        displayContent: content,
        runtimeContent: content,
        titleContent: message,
        typedMessage: message,
      };
    }

    const availableSkills = await loadSkillCommands();
    const resolutions = resolveSkillSlashCommands(parsed.commandNames, availableSkills);
    const pathLikePromptIndex = resolutions.findIndex(
      (resolution, index) =>
        resolution.status !== "resolved" && isPathLikeSlashToken(commandTokens[index]?.name ?? ""),
    );
    if (pathLikePromptIndex === 0) {
      const content = promptWithAttachments(message, messageAttachments);
      return {
        displayContent: content,
        runtimeContent: content,
        titleContent: message,
        typedMessage: message,
      };
    }

    const skillResolutions =
      pathLikePromptIndex === -1 ? resolutions : resolutions.slice(0, pathLikePromptIndex);
    const problem = skillResolutions.find((resolution) => resolution.status !== "resolved");
    if (problem) {
      throw new Error(skillSlashResolutionError(problem) ?? "Skill command failed.");
    }

    const typedMessage =
      pathLikePromptIndex === -1
        ? parsed.prompt.trim()
        : message.slice(commandTokens[pathLikePromptIndex].from).trimStart();
    if (!typedMessage && !messageAttachments.length) {
      throw new Error("Add a request after the skill command.");
    }

    const resolved = skillResolutions.filter(isResolvedSkillSlashResolution);
    const documents = await Promise.all(
      resolved.map(async (resolution) => ({
        ...(await getHermesBridgeSkill(skillDocumentLookupName(resolution.skill.name))),
        name: resolution.skill.name,
      })),
    );
    const displayContent = promptWithAttachments(typedMessage, messageAttachments);
    return {
      displayContent,
      runtimeContent: explicitSkillInvocationPrompt(documents, displayContent),
      titleContent: typedMessage,
      typedMessage,
    };
  }

  async function handleBuiltinComposerSlashCommand(
    commandText: string,
    modelTarget?: CapturedSessionModelTarget,
    dispatchReservation?: HermesSessionDispatchReservation,
  ) {
    if (categoryRef.current) return false;
    const parsed = parseBuiltinComposerSlashCommand(commandText);
    if (!parsed) return false;

    if (parsed.name === "model") {
      await runModelSlashCommand(parsed.argument, commandText, modelTarget);
      return true;
    }

    if (parsed.name === "image") {
      if (!IMAGE_GENERATION_ENABLED) {
        setError("Image generation is not available.");
        return true;
      }
      await runImageSlashCommand(parsed.argument, commandText, modelTarget, dispatchReservation);
      return true;
    }

    if (parsed.name === "video") {
      if (!VIDEO_GENERATION_ENABLED) {
        setError("Video generation is not available.");
        return true;
      }
      await runVideoSlashCommand(parsed.argument, commandText, modelTarget, dispatchReservation);
      return true;
    }

    await runFileSlashCommand(parsed.argument, commandText);
    return true;
  }

  return {
    prepareComposerSubmission,
    handleBuiltinComposerSlashCommand,
  };
}
