import { useEffect } from "react";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import {
  dictationHelperCommand,
  openPrivacySettings,
} from "../../../lib/tauri";
import { StepActions, StepHeading } from "../StepChrome";
import {
  isAccessibilityGranted,
  isMicrophoneDenied,
  isMicrophoneGranted,
  type PermissionStatuses,
} from "../use-permission-status";

function PermissionCard({
  granted,
  title,
  body,
  action,
}: {
  granted: boolean;
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="onboarding-permission-card" data-granted={granted}>
      <div className="onboarding-permission-copy">
        <h2>
          {title}
          {granted ? (
            <span className="onboarding-permission-check" aria-label="Granted">
              <IconCircleCheck size={16} aria-hidden />
            </span>
          ) : null}
        </h2>
        <p>{body}</p>
      </div>
      {!granted && action ? (
        <button
          type="button"
          className="primary-action"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export function PermissionsStep({
  statuses,
  onContinue,
}: {
  statuses: PermissionStatuses;
  onContinue: () => void;
}) {
  const micGranted = isMicrophoneGranted(statuses);
  const micDenied = isMicrophoneDenied(statuses);
  const accessibilityGranted = isAccessibilityGranted(statuses);

  // Fire the native TCC prompt as soon as the screen shows — the user just
  // read why we're asking, so the dialog lands in context. No-op when
  // already granted; for already-denied users the helper emits the current
  // status so the System Settings fallback renders instead.
  useEffect(() => {
    void dictationHelperCommand({
      type: "request_microphone_permission",
    }).catch(() => undefined);
  }, []);

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
    <section className="onboarding-step">
      <StepHeading
        title="Give June permissions on your Mac"
        subtitle="Two permissions power dictation: the microphone to hear you, and accessibility to type your words into whatever app you're using."
      />
      <div className="onboarding-permission-stack">
        <PermissionCard
          granted={micGranted}
          title={
            micGranted ? "June can use your microphone" : "Microphone access"
          }
          body={
            micGranted
              ? "Only when you ask June to listen: dictating, recording a meeting, or testing your mic."
              : micDenied
                ? "Microphone access is turned off for June. Flip the toggle in System Settings, then come back. We'll notice."
                : "June only listens when you ask it to: while you hold the dictation key or record a meeting."
          }
          action={
            micDenied
              ? {
                  label: "Open System Settings",
                  onClick: () => void openPrivacySettings("microphone"),
                }
              : {
                  label: "Allow microphone",
                  onClick: () =>
                    void dictationHelperCommand({
                      type: "request_microphone_permission",
                    }).catch(() => undefined),
                }
          }
        />
        <PermissionCard
          granted={accessibilityGranted}
          title={
            accessibilityGranted
              ? "June can type anywhere"
              : "Accessibility access"
          }
          body={
            accessibilityGranted
              ? "Your spoken words land at your cursor, in any app."
              : "Turn on June in System Settings → Privacy & Security → Accessibility, then come back. We'll notice."
          }
          action={{
            label: "Open System Settings",
            onClick: openAccessibilitySettings,
          }}
        />
      </div>
      <StepActions
        onContinue={onContinue}
        continueDisabled={!micGranted || !accessibilityGranted}
        onSkip={onContinue}
      />
    </section>
  );
}
