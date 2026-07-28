import juneAreas from "../../assets/onboarding/june-areas.png";
import junePermissions from "../../assets/onboarding/june-permissions.png";
import junePersonalityPersonal from "../../assets/onboarding/june-personality-personal.png";
import junePersonalityPlay from "../../assets/onboarding/june-personality-play.png";
import junePersonalityThinking from "../../assets/onboarding/june-personality-thinking.png";
import junePersonalityWork from "../../assets/onboarding/june-personality-work.png";
import juneTelemetry from "../../assets/onboarding/june-telemetry.png";
import juneWelcome from "../../assets/onboarding/june-welcome.png";

export type JuneOnboardingScene =
  | "welcome"
  | "areas"
  | "permissions"
  | "telemetry"
  | "work"
  | "thinking"
  | "personal"
  | "play";

type Props = {
  scene: JuneOnboardingScene;
  size?: "small" | "medium" | "large";
  animated?: boolean;
  className?: string;
};

const ART_BY_SCENE: Record<JuneOnboardingScene, string> = {
  welcome: juneWelcome,
  areas: juneAreas,
  permissions: junePermissions,
  telemetry: juneTelemetry,
  work: junePersonalityWork,
  thinking: junePersonalityThinking,
  personal: junePersonalityPersonal,
  play: junePersonalityPlay,
};

/**
 * Replaceable first-run art direction based on the same bloom character as
 * Home. Each scene is one named PNG so a final vector export can replace it
 * without changing the onboarding layout or option anatomy.
 */
export function JuneOnboardingArt({ scene, size = "medium", animated = false, className }: Props) {
  return (
    <span
      className={`onboarding-june-art${className ? ` ${className}` : ""}`}
      data-scene={scene}
      data-size={size}
      data-animated={animated || undefined}
      aria-hidden="true"
    >
      <img src={ART_BY_SCENE[scene]} alt="" draggable={false} />
    </span>
  );
}
