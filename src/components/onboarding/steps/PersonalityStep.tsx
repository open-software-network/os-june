import { IconCheckmark2Medium } from "central-icons/IconCheckmark2Medium";
import { IconCompassRound } from "central-icons/IconCompassRound";
import { IconSparklesSoft } from "central-icons/IconSparklesSoft";
import { IconSun } from "central-icons/IconSun";
import { IconThinkingBubble } from "central-icons/IconThinkingBubble";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  ONBOARDING_PERSONALITY_PRESETS,
  onboardingPersonality,
  saveOnboardingPersonality,
  type OnboardingArea,
  type OnboardingPersonality,
} from "../../../lib/onboarding";
import {
  PERSONALITY_STEP_SUBTITLES,
  personalityPreviewMessage,
  personalityStylesForArea,
} from "../../../lib/onboarding-personality";
import { setJunePersona } from "../../../lib/tauri";
import { AgentThinking } from "../../agent/AgentThinking";
import { StepActions, StepCard } from "../StepChrome";

const PERSONALITY_STYLE_ICONS = {
  work: IconCompassRound,
  thinking: IconThinkingBubble,
  personal: IconSun,
  play: IconSparklesSoft,
} as const;

type PersonalityAxis = "depth" | "polish" | "playfulness" | "initiative";

const CHART_SIZE = 420;
const CHART_CENTER = CHART_SIZE / 2;
const CHART_RADIUS = 142;
const CHART_LABEL_RADIUS = CHART_RADIUS + 30;

function clampSpectrum(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function axisValue(personality: OnboardingPersonality, axis: PersonalityAxis) {
  if (axis === "depth") return personality.detail;
  if (axis === "polish") return 100 - personality.voice;
  if (axis === "playfulness") return personality.humor;
  return personality.initiative;
}

function withAxisValue(personality: OnboardingPersonality, axis: PersonalityAxis, value: number) {
  const next = clampSpectrum(value);
  if (axis === "depth") return { ...personality, detail: next };
  if (axis === "polish") return { ...personality, voice: 100 - next };
  if (axis === "playfulness") return { ...personality, humor: next };
  return { ...personality, initiative: next };
}

function chartPoint(axis: PersonalityAxis, value: number) {
  const distance = (clampSpectrum(value) / 100) * CHART_RADIUS;
  if (axis === "depth") return { x: CHART_CENTER, y: CHART_CENTER - distance };
  if (axis === "polish") return { x: CHART_CENTER - distance, y: CHART_CENTER };
  if (axis === "playfulness") return { x: CHART_CENTER + distance, y: CHART_CENTER };
  return { x: CHART_CENTER, y: CHART_CENTER + distance };
}

function personalitiesMatch(left: OnboardingPersonality, right: OnboardingPersonality) {
  return (
    left.voice === right.voice &&
    left.detail === right.detail &&
    left.initiative === right.initiative &&
    left.humor === right.humor
  );
}

function valueDescription(value: number) {
  if (value < 25) return "low";
  if (value < 50) return "a little";
  if (value < 75) return "balanced";
  if (value < 90) return "high";
  return "very high";
}

export function PersonalityStep({
  area,
  onContinue,
}: {
  area: OnboardingArea;
  onContinue: () => void;
}) {
  const [personality, setPersonality] = useState<OnboardingPersonality>(() =>
    onboardingPersonality(area),
  );
  const [typing, setTyping] = useState(false);
  const [draggingAxis, setDraggingAxis] = useState<PersonalityAxis | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const typingTimer = useRef<number>();
  const dragOffset = useRef(0);
  const reduceMotion = useReducedMotion();
  const message = useMemo(() => personalityPreviewMessage(area, personality), [area, personality]);
  const personalityStyles = useMemo(() => personalityStylesForArea(area), [area]);
  const previewKey = `${personality.voice}:${personality.detail}:${personality.initiative}:${personality.humor}`;
  const selectedStyle = personalityStyles.find((style) =>
    personalitiesMatch(personality, ONBOARDING_PERSONALITY_PRESETS[style.id]),
  );
  const chartPoints = (["depth", "playfulness", "initiative", "polish"] as const).map((axis) =>
    chartPoint(axis, axisValue(personality, axis)),
  );
  const polygonPoints = chartPoints.map(({ x, y }) => `${x},${y}`).join(" ");

  useEffect(
    () => () => {
      if (typingTimer.current !== undefined) window.clearTimeout(typingTimer.current);
    },
    [],
  );

  function showTypingBriefly() {
    setTyping(true);
    if (typingTimer.current !== undefined) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(
      () => {
        setTyping(false);
        typingTimer.current = undefined;
      },
      reduceMotion ? 80 : 240,
    );
  }

  function setPersonalityValue(next: OnboardingPersonality, typeResponse = false) {
    setPersonality(next);
    saveOnboardingPersonality(next);
    setSaveError(null);
    if (typeResponse) showTypingBriefly();
  }

  function pointerCoordinate(event: PointerEvent<SVGGElement>, axis: PersonalityAxis) {
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return CHART_CENTER;
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * CHART_SIZE;
    const y = ((event.clientY - rect.top) / rect.height) * CHART_SIZE;
    return axis === "depth" || axis === "initiative" ? y : x;
  }

  function coordinateForAxis(axis: PersonalityAxis, value: number) {
    return axis === "depth" || axis === "initiative"
      ? chartPoint(axis, value).y
      : chartPoint(axis, value).x;
  }

  function valueFromCoordinate(axis: PersonalityAxis, coordinate: number) {
    if (axis === "depth") return ((CHART_CENTER - coordinate) / CHART_RADIUS) * 100;
    if (axis === "initiative") return ((coordinate - CHART_CENTER) / CHART_RADIUS) * 100;
    if (axis === "polish") return ((CHART_CENTER - coordinate) / CHART_RADIUS) * 100;
    return ((coordinate - CHART_CENTER) / CHART_RADIUS) * 100;
  }

  function beginDrag(event: PointerEvent<SVGGElement>, axis: PersonalityAxis) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOffset.current =
      coordinateForAxis(axis, axisValue(personality, axis)) - pointerCoordinate(event, axis);
    setTyping(false);
    setDraggingAxis(axis);
  }

  function moveDrag(event: PointerEvent<SVGGElement>, axis: PersonalityAxis) {
    if (draggingAxis !== axis || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const coordinate = pointerCoordinate(event, axis) + dragOffset.current;
    setPersonalityValue(withAxisValue(personality, axis, valueFromCoordinate(axis, coordinate)));
  }

  function endDrag(event: PointerEvent<SVGGElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraggingAxis(null);
  }

  function adjustWithKeyboard(event: KeyboardEvent<SVGGElement>, axis: PersonalityAxis) {
    const current = axisValue(personality, axis);
    let next: number | undefined;
    if (event.key === "ArrowUp" || event.key === "ArrowRight") next = current + 5;
    if (event.key === "ArrowDown" || event.key === "ArrowLeft") next = current - 5;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = 100;
    if (next === undefined) return;
    event.preventDefault();
    setPersonalityValue(withAxisValue(personality, axis, next));
  }

  async function continueWithPersonality() {
    saveOnboardingPersonality(personality);
    setSaving(true);
    setSaveError(null);
    try {
      await setJunePersona({ area, ...personality });
      onContinue();
    } catch {
      setSaveError("I couldn't save this yet. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <StepCard
      title="Choose my personality"
      subtitle={PERSONALITY_STEP_SUBTITLES[area]}
      wide
      className="onboarding-card-personality"
    >
      <div className="onboarding-personality-layout">
        <div className="onboarding-personality-preview">
          <div className="agent-timeline onboarding-personality-thread" data-home="true">
            {typing ? (
              <AgentThinking visible variant="typing-bubble" />
            ) : (
              <AnimatePresence mode="wait" initial={false}>
                <motion.article
                  key={previewKey}
                  className="agent-assistant-turn"
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 2 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -2 }}
                  transition={{ duration: reduceMotion ? 0.1 : 0.16, ease: [0.22, 1, 0.36, 1] }}
                >
                  <div className="agent-assistant-turn-body">
                    <p>{message}</p>
                  </div>
                </motion.article>
              </AnimatePresence>
            )}
          </div>
        </div>

        <div className="onboarding-personality-editor">
          <fieldset className="onboarding-personality-chart-wrap">
            <legend className="visually-hidden">June personality character sheet</legend>
            <svg
              className="onboarding-personality-chart"
              viewBox={`0 0 ${CHART_SIZE} ${CHART_SIZE}`}
              data-dragging={draggingAxis ? "true" : undefined}
            >
              <title>Personality controls</title>
              <g className="onboarding-personality-grid">
                {[0.2, 0.4, 0.6, 0.8, 1].map((level) => {
                  const radius = CHART_RADIUS * level;
                  return (
                    <polygon
                      key={level}
                      points={`${CHART_CENTER},${CHART_CENTER - radius} ${
                        CHART_CENTER + radius
                      },${CHART_CENTER} ${CHART_CENTER},${CHART_CENTER + radius} ${
                        CHART_CENTER - radius
                      },${CHART_CENTER}`}
                    />
                  );
                })}
                <line
                  x1={CHART_CENTER}
                  y1={CHART_CENTER - CHART_RADIUS}
                  x2={CHART_CENTER}
                  y2={CHART_CENTER + CHART_RADIUS}
                />
                <line
                  x1={CHART_CENTER - CHART_RADIUS}
                  y1={CHART_CENTER}
                  x2={CHART_CENTER + CHART_RADIUS}
                  y2={CHART_CENTER}
                />
              </g>

              <motion.polygon
                className="onboarding-personality-shape"
                points={polygonPoints}
                initial={false}
                animate={{ points: polygonPoints }}
                transition={
                  draggingAxis || reduceMotion
                    ? { duration: 0 }
                    : { type: "spring", duration: 0.34, bounce: 0 }
                }
                aria-hidden="true"
              />

              {(["depth", "polish", "playfulness", "initiative"] as const).map((axis) => {
                const point = chartPoint(axis, axisValue(personality, axis));
                const label =
                  axis === "depth"
                    ? "Depth"
                    : axis === "polish"
                      ? "Polish"
                      : axis === "playfulness"
                        ? "Playfulness"
                        : "Initiative";
                return (
                  <motion.g
                    key={axis}
                    className="onboarding-personality-handle"
                    role="slider"
                    tabIndex={0}
                    aria-label={label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={axisValue(personality, axis)}
                    aria-valuetext={valueDescription(axisValue(personality, axis))}
                    initial={false}
                    animate={{ x: point.x, y: point.y }}
                    transition={
                      draggingAxis || reduceMotion
                        ? { duration: 0 }
                        : { type: "spring", duration: 0.34, bounce: 0 }
                    }
                    onPointerDown={(event) => beginDrag(event, axis)}
                    onPointerMove={(event) => moveDrag(event, axis)}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onKeyDown={(event) => adjustWithKeyboard(event, axis)}
                  >
                    <circle className="onboarding-personality-handle-hit" r="20" />
                    <circle className="onboarding-personality-handle-dot" r="9" />
                  </motion.g>
                );
              })}

              <g className="onboarding-personality-axis-labels">
                <text
                  x={CHART_CENTER}
                  y={CHART_CENTER - CHART_LABEL_RADIUS}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  Depth
                </text>
                <text
                  x={CHART_CENTER - CHART_LABEL_RADIUS}
                  y={CHART_CENTER}
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  Polish
                </text>
                <text
                  x={CHART_CENTER + CHART_LABEL_RADIUS}
                  y={CHART_CENTER}
                  textAnchor="start"
                  dominantBaseline="middle"
                >
                  Playfulness
                </text>
                <text
                  x={CHART_CENTER}
                  y={CHART_CENTER + CHART_LABEL_RADIUS}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  Initiative
                </text>
              </g>
            </svg>
            <p className="onboarding-personality-custom-note">Drag any point to make it yours.</p>
          </fieldset>

          <div className="onboarding-personality-presets">
            <div className="onboarding-personality-presets-heading">
              <span>Starting styles</span>
            </div>
            <div className="onboarding-personality-preset-list">
              {personalityStyles.map(({ id, name, description }) => {
                const selected = selectedStyle?.id === id;
                const Icon = PERSONALITY_STYLE_ICONS[id];
                return (
                  <button
                    key={id}
                    type="button"
                    className="onboarding-personality-preset"
                    aria-pressed={selected}
                    onClick={() =>
                      setPersonalityValue({ ...ONBOARDING_PERSONALITY_PRESETS[id] }, true)
                    }
                  >
                    <span className="onboarding-personality-preset-icon" aria-hidden="true">
                      <Icon size={20} />
                    </span>
                    <span className="onboarding-personality-preset-copy">
                      <span>{name}</span>
                      <span>{description}</span>
                    </span>
                    <span
                      className="onboarding-personality-preset-check"
                      aria-hidden="true"
                      data-visible={selected ? "true" : undefined}
                    >
                      <IconCheckmark2Medium size={16} />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      {saveError ? (
        <p className="onboarding-personality-save-error" role="alert">
          {saveError}
        </p>
      ) : null}
      <StepActions
        continueLabel={saving ? "Saving..." : "Continue"}
        continueDisabled={saving}
        onContinue={() => void continueWithPersonality()}
      />
    </StepCard>
  );
}
