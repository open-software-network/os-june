import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconTextIndicator } from "central-icons/IconTextIndicator";
import { IconVolumeFull } from "central-icons/IconVolumeFull";
import type { OnboardingArea } from "../../../lib/onboarding";
import { fallbackDictationCapabilities } from "../../../lib/platform";
import { dictationHelperCommand, openPrivacySettings } from "../../../lib/tauri";
import { StepActions, StepCard } from "../StepChrome";
import {
  isAccessibilityGranted,
  isMicrophoneDenied,
  isMicrophoneGranted,
  type PermissionStatuses,
  type SystemAudioStatus,
} from "../use-permission-status";

const PERMISSION_COPY: Record<
  OnboardingArea,
  {
    subtitle: string;
    microphone: string;
    accessibility: string;
    systemAudio: string;
  }
> = {
  work: {
    subtitle: "This lets Clovy take meeting notes, hear dictation, and type for you.",
    microphone: "Hears your dictation and the meetings you choose to record.",
    accessibility: "Puts your words where you're typing, in any app.",
    systemAudio: "Hears the other people on calls so your meeting notes include everyone.",
  },
  personal: {
    subtitle: "This lets Clovy hear voice notes, type for you, and capture a call when you choose.",
    microphone: "Hears voice notes, reflections, and anything you'd rather say than type.",
    accessibility: "Puts dictated messages and notes into other apps.",
    systemAudio: "Only used when you ask Clovy to capture a call.",
  },
  thinking: {
    subtitle: "This lets Clovy hear rough ideas, type drafts, and capture a conversation.",
    microphone: "Hears you talk through an idea or dictate a draft.",
    accessibility: "Puts your spoken draft into the app you're working in.",
    systemAudio: "Only used when you ask Clovy to capture a call.",
  },
  play: {
    subtitle: "This lets Clovy hear your ideas, type for you, and capture a role-play.",
    microphone: "Hears characters, dialogue, and stories you'd rather speak aloud.",
    accessibility: "Puts dialogue and ideas into the app you're using.",
    systemAudio: "Only used when you ask Clovy to capture a call.",
  },
};

function PermissionRow({
  icon,
  granted,
  probing = false,
  title,
  detail,
  onAllow,
}: {
  icon: ReactNode;
  granted: boolean;
  /** A permission check is in flight (the macOS dialog is up or about to
   * be); the row pulses so the wait reads as activity, not a stall. */
  probing?: boolean;
  title: string;
  detail: string;
  /** Grant affordance — fires the TCC prompt or opens System Settings;
   * either way the user's decision is "allow". */
  onAllow?: () => void;
}) {
  return (
    <li className="onboarding-perm" data-granted={granted} data-probing={probing}>
      <span className="onboarding-perm-icon" aria-hidden>
        {granted ? <IconCheckmark2Small size={15} /> : icon}
      </span>
      <div className="onboarding-perm-copy">
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
      {!granted && onAllow ? (
        <button
          type="button"
          className="onboarding-perm-btn"
          onClick={onAllow}
          aria-label={`Allow ${title.toLowerCase()} access`}
        >
          Allow
        </button>
      ) : null}
    </li>
  );
}

export function PermissionsStep({
  area,
  statuses,
  systemAudioStatus,
  onAllowSystemAudio,
  onContinue,
}: {
  area: OnboardingArea;
  statuses: PermissionStatuses;
  systemAudioStatus: SystemAudioStatus;
  /** Re-runs the capture-helper probe; fires the TCC prompt while the
   * permission is still undetermined. */
  onAllowSystemAudio: () => void;
  onContinue: () => void;
}) {
  const [showUnknownStatuses, setShowUnknownStatuses] = useState(false);
  const micGranted = isMicrophoneGranted(statuses);
  const micDenied = isMicrophoneDenied(statuses);
  const micUnavailable = statuses.microphone === "unavailable";
  const accessibilityGranted = isAccessibilityGranted(statuses);
  const systemAudioGranted = systemAudioStatus === "granted";
  const systemAudioDenied = systemAudioStatus === "denied";
  // macOS < 14.2 (or a missing capture helper) can never grant; the row
  // explains itself and stays out of the Continue gate.
  const systemAudioUnsupported = systemAudioStatus === "unsupported";
  // Granted, but the helper cannot capture until Clovy restarts. Onboarding has
  // nothing left to ask for, so the row explains itself and clears the gate
  // too. It is not marked granted: the source does not work yet.
  const systemAudioUnavailable = systemAudioStatus === "unavailable";
  const systemAudioSettled = systemAudioGranted || systemAudioUnsupported || systemAudioUnavailable;
  const showPermissionRows = statuses.checked || showUnknownStatuses;
  const capabilities = fallbackDictationCapabilities();
  const macLikePlatform = capabilities.platform === "macos";
  const windowsPlatform = capabilities.platform === "windows";
  const copy = PERMISSION_COPY[area];

  // Fire the native TCC prompt as soon as the screen shows — the user just
  // read why we're asking, so the dialog lands in context. No-op when
  // already granted; for already-denied users the helper emits the current
  // status so the System Settings fallback renders instead.
  useEffect(() => {
    void dictationHelperCommand({
      type: "request_microphone_permission",
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (statuses.checked) {
      setShowUnknownStatuses(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setShowUnknownStatuses(true);
    }, 240);

    return () => window.clearTimeout(timer);
  }, [statuses.checked]);

  function openAccessibilitySettings() {
    // Fire the helper's prompting check first: it registers the dictation
    // helper in the Accessibility list (so there's a toggle to flip) and
    // shows the native dialog. Let macOS own the System Settings handoff so
    // the native prompt is not left open behind a programmatic settings launch.
    void dictationHelperCommand({
      type: "request_accessibility_permission",
    }).catch(() => undefined);
  }

  return (
    <StepCard
      title="Let Clovy listen and type"
      subtitle={
        macLikePlatform
          ? copy.subtitle
          : windowsPlatform
            ? "Dictation and meeting notes need microphone access."
            : "Meeting notes need microphone access."
      }
      wide
    >
      <ul
        className="onboarding-perms"
        data-checking={!showPermissionRows}
        aria-busy={!showPermissionRows}
      >
        <PermissionRow
          icon={<IconMicrophone size={15} />}
          granted={showPermissionRows && micGranted}
          title="Microphone"
          detail={
            micUnavailable
              ? "No microphone found. Connect one, choose it in Windows sound settings, then try again."
              : micDenied
                ? macLikePlatform
                  ? "Turned off in System Settings. Flip the toggle and Clovy will notice."
                  : "Turned off in Windows settings. Flip the toggle and Clovy will notice."
                : copy.microphone
          }
          onAllow={
            showPermissionRows
              ? micUnavailable
                ? () =>
                    void dictationHelperCommand({
                      type: "get_permission_status",
                    }).catch(() => undefined)
                : micDenied
                  ? () => void openPrivacySettings("microphone")
                  : () =>
                      void dictationHelperCommand({
                        type: "request_microphone_permission",
                      }).catch(() => undefined)
              : undefined
          }
        />
        {macLikePlatform ? (
          <>
            <PermissionRow
              icon={<IconTextIndicator size={15} />}
              granted={showPermissionRows && accessibilityGranted}
              title="Accessibility"
              detail={copy.accessibility}
              onAllow={showPermissionRows ? openAccessibilitySettings : undefined}
            />
            <PermissionRow
              icon={<IconVolumeFull size={15} />}
              granted={showPermissionRows && systemAudioGranted}
              probing={showPermissionRows && systemAudioStatus === "probing"}
              title="System audio"
              detail={
                systemAudioDenied
                  ? "Turned off in System Settings. Flip the toggle and Clovy will notice."
                  : systemAudioUnsupported
                    ? "Needs macOS 14.2 or later."
                    : systemAudioUnavailable
                      ? "Allowed. Restart Clovy to finish turning it on."
                      : systemAudioStatus === "probing"
                        ? "Waiting for macOS. Approve the prompt when it appears."
                        : copy.systemAudio
              }
              onAllow={
                showPermissionRows
                  ? systemAudioDenied
                    ? () => void openPrivacySettings("systemAudio")
                    : systemAudioStatus === "unknown"
                      ? onAllowSystemAudio
                      : undefined
                  : undefined
              }
            />
          </>
        ) : null}
      </ul>
      <StepActions
        onContinue={onContinue}
        continueDisabled={
          !showPermissionRows ||
          !micGranted ||
          (macLikePlatform && (!accessibilityGranted || !systemAudioSettled))
        }
        onSkip={onContinue}
      />
    </StepCard>
  );
}
