import {
  hermesBridgeFilesystemSnapshot,
  hermesBridgeMessagingPlatforms,
  hermesBridgeSkills,
  hermesBridgeToolsets,
} from "../../lib/tauri";
import { messageFromError } from "../../lib/errors";
import { withTimeout } from "../../lib/async-timeout";
import {
  MESSAGING_PLATFORMS_LOAD_TIMEOUT_MESSAGE,
  MESSAGING_PLATFORMS_LOAD_TIMEOUT_MS,
} from "../../lib/hermes-messaging";
import { isSessionGoneError } from "./agent-workspace-errors";
import type { createManagementLoadersDependencies } from "./management-loaders-types";

export function createManagementLoaders(dependencies: createManagementLoadersDependencies) {
  const {
    ensureHermesGateway,
    selectedHermesSessionIdRef,
    setCapabilityLoading,
    setError,
    setFilesystemLoading,
    setFilesystemSnapshot,
    setMessagingPlatforms,
    setSelectedMessagingPlatformId,
    setSkillCommandLoading,
    setSkills,
    setToolsets,
    skillCommandsLoadRef,
    skills,
  } = dependencies;

  async function loadSkillCommands(options?: { silent?: boolean }) {
    if (skills) return skills;
    let loadPromise = skillCommandsLoadRef.current;
    if (!loadPromise) {
      setSkillCommandLoading(true);
      loadPromise = (async () => {
        await ensureHermesGateway();
        const nextSkills = await hermesBridgeSkills();
        setSkills(nextSkills);
        return nextSkills;
      })();
      skillCommandsLoadRef.current = loadPromise;
    }

    try {
      return await loadPromise;
    } catch (err) {
      if (!options?.silent) {
        throw new Error(`Skill commands are unavailable. ${messageFromError(err)}`);
      }
      return [];
    } finally {
      if (skillCommandsLoadRef.current === loadPromise) {
        skillCommandsLoadRef.current = null;
        setSkillCommandLoading(false);
      }
    }
  }

  async function loadCapabilities() {
    setCapabilityLoading(true);
    try {
      await ensureHermesGateway();
      const [nextSkills, nextToolsets] = await Promise.all([
        hermesBridgeSkills(),
        hermesBridgeToolsets(),
      ]);
      setSkills(nextSkills);
      setToolsets(nextToolsets);
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setCapabilityLoading(false);
    }
  }

  async function loadMessagingPlatforms() {
    setCapabilityLoading(true);
    try {
      await ensureHermesGateway();
      const response = await withTimeout(
        hermesBridgeMessagingPlatforms(),
        MESSAGING_PLATFORMS_LOAD_TIMEOUT_MS,
        MESSAGING_PLATFORMS_LOAD_TIMEOUT_MESSAGE,
      );
      setMessagingPlatforms(response.platforms);
      setSelectedMessagingPlatformId((current) => {
        if (current && response.platforms.some((item) => item.id === current)) {
          return current;
        }
        return response.platforms[0]?.id;
      });
      setError(null);
    } catch (err) {
      setMessagingPlatforms((current) => current ?? []);
      setError(messageFromError(err));
    } finally {
      setCapabilityLoading(false);
    }
  }

  async function loadFilesystemSnapshot() {
    const sessionId = selectedHermesSessionIdRef.current ?? null;
    setFilesystemLoading(true);
    try {
      await ensureHermesGateway();
      setFilesystemSnapshot(await hermesBridgeFilesystemSnapshot());
      // No setError(null): this refires in the background on message-count
      // changes, so a success would wipe an unrelated banner (e.g. a failed
      // send). The banner is dismissable instead.
    } catch (err) {
      const message = messageFromError(err);
      if (isSessionGoneError(message)) return;
      setError(message, { sessionId });
    } finally {
      setFilesystemLoading(false);
    }
  }

  return {
    loadSkillCommands,
    loadCapabilities,
    loadMessagingPlatforms,
    loadFilesystemSnapshot,
  };
}
