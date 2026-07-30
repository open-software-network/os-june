import calmCharacter from "../../assets/onboarding/characters/calm.svg?raw";
import clearheadedCharacter from "../../assets/onboarding/characters/clearheaded.svg?raw";
import quickWittedCharacter from "../../assets/onboarding/characters/quick-witted.svg?raw";
import strategicCharacter from "../../assets/onboarding/characters/strategic.svg?raw";
import type { OnboardingMood } from "../../lib/onboarding";

// SVG user-space units in the shared 291x302 character canvas. The backing is
// a real rounded stroke rather than a morphology filter: rectangular dilation
// flattens the vertical tips of Quick-witted and reads like viewport clipping.
const STICKER_KEYLINE_WIDTH = 20;
const STICKER_CANVAS_WIDTH = 291;
const STICKER_CANVAS_HEIGHT = 302;
// The supplied paths reach the edge of their canvas (Calm even extends a few
// units past it). Reserve real user-space around every path so morphology can
// grow the white backing without either the SVG viewport or filter clipping it.
const STICKER_VIEWBOX_PADDING = 16;

export const ONBOARDING_MOOD_PRESENTATION: Record<
  OnboardingMood,
  {
    label: string;
    description: string;
    greeting: string;
    path: string;
  }
> = {
  calm: {
    label: "Calm",
    description: "Steady, warm, and unhurried",
    greeting: "Take your time. What should we think through first?",
    path: pathFromSvg(calmCharacter),
  },
  clearheaded: {
    label: "Clearheaded",
    description: "Crisp, thoughtful, and composed",
    greeting: "What should we make clearer first?",
    path: pathFromSvg(clearheadedCharacter),
  },
  "quick-witted": {
    label: "Quick-witted",
    description: "Fast, playful, and a little surprising",
    greeting: "All right, what's first?",
    path: pathFromSvg(quickWittedCharacter),
  },
  strategic: {
    label: "Strategic",
    description: "Proactive, practical, and two steps ahead",
    greeting: "What should we get ahead of first?",
    path: pathFromSvg(strategicCharacter),
  },
};

export function OnboardingCharacter({
  mood,
  className,
}: {
  mood: OnboardingMood;
  className?: string;
}) {
  const presentation = ONBOARDING_MOOD_PRESENTATION[mood];

  return (
    <span
      className={`onboarding-character${className ? ` ${className}` : ""}`}
      data-mood={mood}
      aria-hidden="true"
    >
      <svg
        className="onboarding-character-art"
        viewBox={`${-STICKER_VIEWBOX_PADDING} ${-STICKER_VIEWBOX_PADDING} ${STICKER_CANVAS_WIDTH + STICKER_VIEWBOX_PADDING * 2} ${STICKER_CANVAS_HEIGHT + STICKER_VIEWBOX_PADDING * 2}`}
        preserveAspectRatio="xMidYMid meet"
        focusable="false"
      >
        <title>{presentation.label} sticker</title>
        <path
          className="onboarding-character-keyline"
          d={presentation.path}
          fillRule="evenodd"
          clipRule="evenodd"
          strokeWidth={STICKER_KEYLINE_WIDTH}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          className="onboarding-character-ink"
          d={presentation.path}
          fillRule="evenodd"
          clipRule="evenodd"
        />
      </svg>
    </span>
  );
}

function pathFromSvg(markup: string) {
  const path = markup.match(/\sd="([^"]+)"/)?.[1];
  if (!path) throw new Error("Onboarding character SVG is missing its path data");
  return path;
}
