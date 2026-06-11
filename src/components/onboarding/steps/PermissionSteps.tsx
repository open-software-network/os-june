import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconTextIndicator } from "central-icons/IconTextIndicator";
import {
  dictationHelperCommand,
  openPrivacySettings,
} from "../../../lib/tauri";
import { StepActions, StepCard } from "../StepChrome";
import {
  isAccessibilityGranted,
  isMicrophoneDenied,
  isMicrophoneGranted,
  type PermissionStatuses,
} from "../use-permission-status";

function PermissionRow({
  icon,
  granted,
  title,
  detail,
  onAllow,
}: {
  icon: ReactNode;
  granted: boolean;
  title: string;
  detail: string;
  /** Grant affordance — fires the TCC prompt or opens System Settings;
   * either way the user's decision is "allow". */
  onAllow?: () => void;
}) {
  return (
    <li className="onboarding-perm" data-granted={granted}>
      <span className="onboarding-perm-icon" aria-hidden>
        {granted ? <IconCheckmark1Small size={15} /> : icon}
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
  statuses,
  onContinue,
}: {
  statuses: PermissionStatuses;
  onContinue: () => void;
}) {
  const [showUnknownStatuses, setShowUnknownStatuses] = useState(false);
  const micGranted = isMicrophoneGranted(statuses);
  const micDenied = isMicrophoneDenied(statuses);
  const accessibilityGranted = isAccessibilityGranted(statuses);
  const showPermissionRows = statuses.checked || showUnknownStatuses;

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
    // shows the native dialog. Open the pane only after that IPC resolves —
    // sequenced, not concurrent, so the registration lands before System
    // Settings can steal focus from the prompt. (Same dance as
    // PermissionBanner.)
    void dictationHelperCommand({ type: "request_accessibility_permission" })
      .catch(() => undefined)
      .finally(() => {
        void openPrivacySettings("accessibility");
      });
  }

  return (
    <StepCard
      title="Let June listen and type"
      subtitle="Dictation needs two macOS permissions."
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
            micDenied
              ? "Turned off in System Settings. Flip the toggle and June will notice."
              : "Hears you only when you ask June to listen."
          }
          onAllow={
            showPermissionRows
              ? micDenied
                ? () => void openPrivacySettings("microphone")
                : () =>
                    void dictationHelperCommand({
                      type: "request_microphone_permission",
                    }).catch(() => undefined)
              : undefined
          }
        />
        <PermissionRow
          icon={<IconTextIndicator size={15} />}
          granted={showPermissionRows && accessibilityGranted}
          title="Accessibility"
          detail="Types your words at your cursor, in any app."
          onAllow={showPermissionRows ? openAccessibilitySettings : undefined}
        />
      </ul>
      <StepActions
        onContinue={onContinue}
        continueDisabled={
          !showPermissionRows || !micGranted || !accessibilityGranted
        }
        onSkip={onContinue}
      />
    </StepCard>
  );
}
