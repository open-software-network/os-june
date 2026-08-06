import { useEffect, useId, useRef, type SVGProps } from "react";
import { CLOVY_BODY_PATH, CLOVY_MARK_VIEWBOX } from "./ClovyLogo";

const EYE = { left: 114, right: 149, y: 131.5, width: 12, height: 20.5 };
const NOTCH = 0.55;

function eyePath(width: number, height: number, notch = NOTCH) {
  const n = (value: number) => value.toFixed(2);
  const bottom = height * (0.95 - notch * 0.78);
  return [
    `M ${n(-width)} 0`,
    `C ${n(-width)} ${n(-height * 1.32)}, ${n(width)} ${n(-height * 1.32)}, ${n(width)} 0`,
    `C ${n(width)} ${n(height * 0.66)}, ${n(width * 0.7)} ${n(height * 0.98)}, 0 ${n(bottom)}`,
    `C ${n(-width * 0.7)} ${n(height * 0.98)}, ${n(-width)} ${n(height * 0.66)}, ${n(-width)} 0 Z`,
  ].join(" ");
}

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);
const RESTING_EYE_PATH = eyePath(EYE.width, EYE.height);

type ClovyAliveProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  label?: string;
  palette?: "appearance" | "identity";
};

/** The living Clovy mark shared with the marketing page. */
export function ClovyAlive({ className, label, palette = "identity", ...props }: ClovyAliveProps) {
  const id = useId().replaceAll(":", "");
  const gradientId = `clovy-alive-${id}`;
  const sheenId = `clovy-alive-sheen-${id}`;
  const rimId = `clovy-alive-rim-${id}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const bodyRef = useRef<SVGGElement>(null);
  const leftEyeRef = useRef<SVGPathElement>(null);
  const rightEyeRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const body = bodyRef.current;
    const leftEye = leftEyeRef.current;
    const rightEye = rightEyeRef.current;
    if (!svg || !body || !leftEye || !rightEye) return;

    const staticQuery = window.matchMedia("(prefers-reduced-motion: reduce), (pointer: coarse)");
    let frameId = 0;
    let previousTime = 0;
    let visible = false;
    let pointerSeen = false;
    let pointerX = 0;
    let pointerY = 0;
    let pointerIdle = 99;
    let gazeX = 0;
    let gazeY = 0;
    let bodyX = 0;
    let bodyY = 0;
    let bodyRotation = 0;
    let wanderX = 0;
    let wanderY = 0;
    let nextWander = randomBetween(0.8, 2.2);
    let nextBlink = randomBetween(0.6, 2.4);
    let blinkTime = -1;
    let blinkDuration = 0.17;
    let blinkKind: "both" | "left" | "right" = "both";
    let secondBlinkPending = false;

    const damp = (from: number, to: number, lambda: number, delta: number) =>
      from + (to - from) * (1 - Math.exp(-lambda * delta));

    const drawEye = (eye: SVGPathElement, centerX: number, lid: number) => {
      const height = Math.max(EYE.height * lid, 0.1);
      eye.setAttribute("d", eyePath(EYE.width, height, lid > 0.35 ? NOTCH : 0));
      eye.setAttribute("transform", `translate(${centerX + gazeX} ${EYE.y + gazeY})`);
    };

    const reset = () => {
      gazeX = 0;
      gazeY = 0;
      bodyX = 0;
      bodyY = 0;
      bodyRotation = 0;
      body.style.transform = "translate(0, 0) rotate(0deg)";
      leftEye.setAttribute("d", RESTING_EYE_PATH);
      leftEye.setAttribute("transform", `translate(${EYE.left} ${EYE.y})`);
      rightEye.setAttribute("d", RESTING_EYE_PATH);
      rightEye.setAttribute("transform", `translate(${EYE.right} ${EYE.y})`);
    };

    const stop = () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      frameId = 0;
      previousTime = 0;
    };

    const tick = (time: number) => {
      frameId = 0;
      if (staticQuery.matches || !visible || document.hidden) {
        previousTime = 0;
        return;
      }

      const delta = previousTime ? Math.min((time - previousTime) / 1000, 0.05) : 0.016;
      previousTime = time;
      pointerIdle += delta;

      let targetX = 0;
      let targetY = 0;
      if (pointerSeen && pointerIdle < 3.5) {
        const bounds = svg.getBoundingClientRect();
        const dx = pointerX - (bounds.left + bounds.width * 0.5);
        const dy = pointerY - (bounds.top + bounds.height * 0.44);
        const distance = Math.hypot(dx, dy) || 1;
        const strength = Math.min(1, distance / 260);
        targetX = (dx / distance) * strength * 9;
        targetY = (dy / distance) * strength * 6;
        nextWander = randomBetween(1.2, 3.4);
      } else {
        nextWander -= delta;
        if (nextWander <= 0) {
          nextWander = randomBetween(1.1, 3.6);
          wanderX = randomBetween(-8, 8);
          wanderY = randomBetween(-4, 5);
        }
        targetX = wanderX;
        targetY = wanderY;
      }

      gazeX = damp(gazeX, targetX, 17, delta);
      gazeY = damp(gazeY, targetY, 17, delta);
      bodyX = damp(bodyX, targetX * 0.11, 4.6, delta);
      bodyY = damp(bodyY, targetY * 0.08, 4.6, delta);
      bodyRotation = damp(bodyRotation, targetX * 0.055, 4.2, delta);
      body.style.transform = `translate(${bodyX}px, ${bodyY}px) rotate(${bodyRotation}deg)`;

      nextBlink -= delta;
      if (blinkTime < 0 && nextBlink <= 0) {
        if (secondBlinkPending) {
          blinkKind = "both";
          blinkDuration = 0.15;
          secondBlinkPending = false;
          nextBlink = randomBetween(1.9, 5.4);
        } else {
          const roll = Math.random();
          if (roll < 0.16) {
            blinkKind = Math.random() < 0.5 ? "left" : "right";
            blinkDuration = 0.46;
            nextBlink = randomBetween(2.4, 5.5);
          } else if (roll < 0.44) {
            blinkKind = "both";
            blinkDuration = 0.15;
            secondBlinkPending = true;
            nextBlink = randomBetween(0.16, 0.24);
          } else {
            blinkKind = "both";
            blinkDuration = 0.17;
            nextBlink = randomBetween(1.9, 5.4);
          }
        }
        blinkTime = 0;
      }

      let leftLid = 1;
      let rightLid = 1;
      if (blinkTime >= 0) {
        blinkTime += delta;
        const progress = blinkTime / blinkDuration;
        if (progress >= 1) {
          blinkTime = -1;
        } else {
          const shut =
            progress < 0.28
              ? 1 - (1 - progress / 0.28) ** 2
              : progress < 0.62
                ? 1
                : 1 - ((progress - 0.62) / 0.38) ** 1.6;
          const open = 1 - shut;
          leftLid = blinkKind === "right" ? 1 : open;
          rightLid = blinkKind === "left" ? 1 : open;
        }
      }

      drawEye(leftEye, EYE.left, leftLid);
      drawEye(rightEye, EYE.right, rightLid);
      frameId = window.requestAnimationFrame(tick);
    };

    const start = () => {
      if (frameId || staticQuery.matches || !visible || document.hidden) return;
      previousTime = 0;
      frameId = window.requestAnimationFrame(tick);
    };

    const onPointerMove = (event: PointerEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      pointerSeen = true;
      pointerIdle = 0;
    };
    const onPointerOut = (event: PointerEvent) => {
      if (!event.relatedTarget) pointerSeen = false;
    };
    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };
    const onStaticPreferenceChange = () => {
      if (staticQuery.matches) {
        stop();
        reset();
      } else {
        start();
      }
    };

    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              visible = entries.at(-1)?.isIntersecting ?? false;
              if (visible) start();
              else stop();
            },
            { rootMargin: "80px" },
          );
    if (observer) {
      observer.observe(svg);
    } else {
      visible = true;
      start();
    }
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerMove, { passive: true });
    window.addEventListener("pointerout", onPointerOut);
    document.addEventListener("visibilitychange", onVisibilityChange);
    staticQuery.addEventListener("change", onStaticPreferenceChange);
    if (staticQuery.matches) reset();

    return () => {
      observer?.disconnect();
      stop();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerMove);
      window.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      staticQuery.removeEventListener("change", onStaticPreferenceChange);
    };
  }, []);

  return (
    <svg
      ref={svgRef}
      viewBox={CLOVY_MARK_VIEWBOX}
      focusable="false"
      className={`clovy-alive${className ? ` ${className}` : ""}`}
      data-palette={palette}
      {...(label ? { "aria-label": label, role: "img" as const } : { "aria-hidden": true })}
      {...props}
    >
      <title>{label ?? "Clovy"}</title>
      <defs>
        <linearGradient
          id={gradientId}
          x1="128.5"
          x2="128.5"
          y1="0"
          y2="264"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--clovy-alive-fill-top, var(--clovy-glow-top))" />
          <stop offset="1" stopColor="var(--clovy-alive-fill-bottom, var(--clovy-glow))" />
        </linearGradient>
        <radialGradient
          id={sheenId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(74 34) rotate(48) scale(188 212)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--clovy-alive-sheen-color, var(--clovy-lime-top))" />
          <stop offset="0.56" stopColor="transparent" />
        </radialGradient>
        <linearGradient
          id={rimId}
          x1="128.5"
          x2="128.5"
          y1="0"
          y2="264"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--clovy-alive-rim-color, var(--clovy-lime-top))" />
          <stop
            offset="0.72"
            stopColor="var(--clovy-alive-rim-color, var(--clovy-lime-top))"
            stopOpacity="0"
          />
        </linearGradient>
      </defs>
      <g ref={bodyRef} className="clovy-alive-body">
        <path className="clovy-alive-depth" d={CLOVY_BODY_PATH} transform="translate(0 5.5)" />
        <path d={CLOVY_BODY_PATH} fill={`url(#${gradientId})`} />
        <path className="clovy-alive-sheen" d={CLOVY_BODY_PATH} fill={`url(#${sheenId})`} />
        <path
          className="clovy-alive-rim"
          d={CLOVY_BODY_PATH}
          fill="none"
          stroke={`url(#${rimId})`}
          strokeWidth="1.64"
        />
        <path
          ref={leftEyeRef}
          d={RESTING_EYE_PATH}
          transform={`translate(${EYE.left} ${EYE.y})`}
          className="clovy-alive-eye"
        />
        <path
          ref={rightEyeRef}
          d={RESTING_EYE_PATH}
          transform={`translate(${EYE.right} ${EYE.y})`}
          className="clovy-alive-eye"
        />
      </g>
    </svg>
  );
}
