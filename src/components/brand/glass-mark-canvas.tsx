// The June "agents" glyph (the two notched bars from the app icon), extruded
// from its vector paths and rendered as a real refracting-glass object — true
// transmission, IOR, and chromatic aberration via drei's MeshTransmissionMaterial.
// Themeable, self-contained (no external HDR), transparent canvas so the card
// shows behind it.
//
// This is the HEAVY module: it pulls in three/fiber/drei and is only ever
// reached through React.lazy from JuneGlassMark (never in the main bundle).
// Ported from os-marketing-page's components/agents-glass.tsx — the material and
// lighting values in GLASS_DEFAULTS below are the tuned rig from that repo. The
// per-brand COLORS come in as a GlassPalette prop (see src/lib/brand-glass.ts).

import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import {
  Environment,
  Float,
  Lightformer,
  MeshTransmissionMaterial,
  OrthographicCamera,
  PerspectiveCamera,
} from "@react-three/drei";
import * as THREE from "three";
import { SVGLoader } from "three-stdlib";
import type { GlassPalette } from "../../lib/brand-glass";
import { adjustOklch } from "../../lib/oklch";

// The two glyph paths (viewBox 0 0 12 14), matching the flat JuneMark SVG.
const SVG_PATHS = [
  "M11.5 6.5C11.7761 6.5 12 6.72386 12 7V8.5C12 8.77614 11.7761 9 11.5 9H10.4141C10.2815 9.00002 10.1543 9.05273 10.0605 9.14648L9.64648 9.56055C9.55273 9.6543 9.50002 9.78148 9.5 9.91406V11C9.5 11.2761 9.27614 11.5 9 11.5H3.41406C3.28148 11.5 3.1543 11.5527 3.06055 11.6465L2.64648 12.0605C2.55273 12.1543 2.50002 12.2815 2.5 12.4141V13.5C2.5 13.7761 2.27614 14 2 14H0.5C0.223858 14 0 13.7761 0 13.5V12C4.02663e-09 11.7239 0.223858 11.5 0.5 11.5H1.58594C1.71852 11.5 1.8457 11.4473 1.93945 11.3535L2.35352 10.9395C2.44727 10.8457 2.49998 10.7185 2.5 10.5859V9.5C2.5 9.22386 2.72386 9 3 9H8.58594C8.71852 8.99998 8.8457 8.94727 8.93945 8.85352L9.35352 8.43945C9.44727 8.3457 9.49998 8.21852 9.5 8.08594V7C9.5 6.72386 9.72386 6.5 10 6.5H11.5Z",
  "M11.5 0C11.7761 4.02663e-09 12 0.223858 12 0.5V2C12 2.27614 11.7761 2.5 11.5 2.5H10.4141C10.2815 2.50002 10.1543 2.55273 10.0605 2.64648L9.64648 3.06055C9.55273 3.1543 9.50002 3.28148 9.5 3.41406V4.5C9.5 4.77614 9.27614 5 9 5H3.41406C3.28148 5.00002 3.1543 5.05273 3.06055 5.14648L2.64648 5.56055C2.55273 5.6543 2.50002 5.78148 2.5 5.91406V7C2.5 7.27614 2.27614 7.5 2 7.5H0.5C0.223858 7.5 0 7.27614 0 7V5.5C4.02663e-09 5.22386 0.223858 5 0.5 5H1.58594C1.71852 4.99998 1.8457 4.94727 1.93945 4.85352L2.35352 4.43945C2.44727 4.3457 2.49998 4.21852 2.5 4.08594V3C2.5 2.72386 2.72386 2.5 3 2.5H8.58594C8.71852 2.49998 8.8457 2.44727 8.93945 2.35352L9.35352 1.93945C9.44727 1.8457 9.49998 1.71852 9.5 1.58594V0.5C9.5 0.223858 9.72386 0 10 0H11.5Z",
];

const EXTRUDE = {
  depth: 3,
  bevelEnabled: true,
  bevelThickness: 0.45,
  bevelSize: 0.32,
  bevelSegments: 5,
  curveSegments: 18,
} satisfies THREE.ExtrudeGeometryOptions;

/** Fit the whole mark into ~this many world units across its largest side. */
const TARGET_SIZE = 3.6;
const HIT_PADDING = 0.85;
const HIT_Z = EXTRUDE.depth + 0.08;

/** The drei <Environment> is baked once (frames={1}); it only re-bakes when its
 *  React key changes. The key is built from material/intensity values — NOT the
 *  lightformer POSITIONS — so bump this whenever the rig geometry changes to
 *  force a re-bake. */
const RIG_VERSION = "perspective-stripes · 2026-06-28";

// A dark reflection environment has less white dilution, so the same palette
// reads hotter there. Calm every chromatic glass color consistently instead of
// maintaining a second hand-tuned palette for each accent.
const DARK_CHROMA_SCALE = 0.85;
const DARK_LIGHTNESS_LIFT = 0.03;
const ENV_THEME_FADE = 0.45;

/* ----------------------------------------------------------- tunable look --
 * The whole glass look. Colors are supplied per-brand (GlassPalette); the rest
 * are the tuned material/lighting/framing values ported from the marketing rig. */

type GlassParams = GlassPalette & {
  // material
  attenuationDistance: number; // ↑ = lighter / less saturated
  thickness: number;
  roughness: number;
  ior: number;
  transmission: number;
  reflectivity: number;
  chromaticAberration: number;
  backsideThickness: number;
  // lighting
  ambient: number;
  keyIntensity: number;
  sideIntensity: number;
  topIntensity: number;
  streakIntensity: number;
  // framing / motion
  viewSize: number;
  perspective: number;
  restX: number;
  restY: number;
};

// Non-color defaults — the tuned rig. Merged with the per-brand palette below.
const GLASS_DEFAULTS = {
  // Glassy: full transmission, a long attenuation distance so the body color is
  // a tint seen THROUGH rather than a dense solid, and a touch of roughness so
  // the reflections read as glass, not chrome.
  attenuationDistance: 5.5,
  thickness: 1.6,
  roughness: 0.2,
  ior: 1.3,
  transmission: 1,
  reflectivity: 0.53,
  chromaticAberration: 0.12,
  backsideThickness: 0.8,
  ambient: 2,
  // Drives the soft, centered FRONT FILL (head-on sheen) — a large centered area
  // fill reflects a near-constant value, so it's a steady sheen, never a flash.
  keyIntensity: 1.5,
  sideIntensity: 4.8,
  topIntensity: 2.2,
  // Narrow forward streaks — the bright "window" stripes that read as moving
  // lines under the perspective camera.
  streakIntensity: 3,
  viewSize: 6,
  // Perspective ON — makes the streaks read as moving stripes and gives the mark
  // real dimension. ~0.7 is a strong, dimensional look.
  perspective: 0.7,
  restX: -0.04,
  restY: 0.07,
} satisfies Omit<GlassParams, keyof GlassPalette>;

/** June's theme is `data-theme="dark"` on <html> (set by src/lib/theme.ts).
 *  Observe that attribute so the reflection environment follows theme flips. */
function subscribeTheme(onChange: () => void) {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => obs.disconnect();
}
const isDarkSnapshot = () => document.documentElement.getAttribute("data-theme") === "dark";
function useIsDark(): boolean {
  return useSyncExternalStore(subscribeTheme, isDarkSnapshot, () => false);
}

/** Holds the canvas hidden only until it has actually drawn a few real frames —
 *  the first frame of a transmission material can flash an uninitialized (white)
 *  buffer, so we skip it. No deliberate time beat: the mark should read as
 *  already-there with the rest of the welcome content, not ease in afterward. */
function RevealGate({
  minFrames = 4,
  minDelay = 0,
  onReady,
}: {
  minFrames?: number;
  minDelay?: number;
  onReady: () => void;
}) {
  const frames = useRef(0);
  const done = useRef(false);
  useFrame((state) => {
    if (done.current) return;
    frames.current += 1;
    if (frames.current >= minFrames && state.clock.elapsedTime >= minDelay) {
      done.current = true;
      onReady();
    }
  });
  return null;
}

/** Pause the render loop whenever the mark can't be seen — scrolled out of view,
 *  or the window is hidden/backgrounded. The transmission material renders
 *  several full-scene buffers per frame, so an idle canvas is a large, free
 *  GPU/battery win. R3F stops the clock while frameloop is "never", so the idle
 *  sway resumes at the same phase when the mark comes back. */
function useRenderActive<T extends HTMLElement>(ref: RefObject<T | null>) {
  const [active, setActive] = useState(true);
  useEffect(() => {
    const el = ref.current;
    let inView = true;
    let visible = typeof document === "undefined" || !document.hidden;
    const sync = () => setActive(inView && visible);

    const onVisibility = () => {
      visible = !document.hidden;
      sync();
    };
    document.addEventListener("visibilitychange", onVisibility);

    let io: IntersectionObserver | undefined;
    if (el && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        (entries) => {
          inView = entries.some((e) => e.isIntersecting);
          sync();
        },
        { rootMargin: "120px" },
      );
      io.observe(el);
    }
    sync();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      io?.disconnect();
    };
  }, [ref]);
  return active;
}

function CameraRig({ viewSize, perspective }: { viewSize: number; perspective: number }) {
  const height = useThree((s) => s.size.height);

  if (perspective <= 0.001) {
    return (
      <OrthographicCamera
        makeDefault
        position={[0, 0, 12]}
        zoom={height / viewSize}
        near={0.1}
        far={100}
      />
    );
  }

  const fov = perspective * 30; // 0..1 dial → up to 30° of perspective
  const dist = viewSize / (2 * Math.tan((fov * Math.PI) / 360));
  return (
    <PerspectiveCamera makeDefault fov={fov} position={[0, 0, dist]} near={0.1} far={dist + 100} />
  );
}

function useGlyphGeometries() {
  return useMemo(() => {
    // SVGLoader parses a full document, so wrap the paths in a minimal SVG.
    const svg = `<svg viewBox="0 0 12 14" xmlns="http://www.w3.org/2000/svg">${SVG_PATHS.map(
      (d) => `<path d="${d}" fill="#000"/>`,
    ).join("")}</svg>`;
    const { paths } = new SVGLoader().parse(svg);

    const geometries: THREE.ExtrudeGeometry[] = [];
    for (const path of paths) {
      // three-stdlib's SVGResultPaths and @types/three's ShapePath differ only in
      // an optional userData field; the cast bridges that harmless type friction.
      const shapes = SVGLoader.createShapes(
        path as unknown as Parameters<typeof SVGLoader.createShapes>[0],
      );
      for (const shape of shapes) {
        geometries.push(new THREE.ExtrudeGeometry(shape, EXTRUDE));
      }
    }

    // Center on origin and normalize scale from a combined bounding box.
    const box = new THREE.Box3();
    for (const g of geometries) {
      g.computeBoundingBox();
      if (g.boundingBox) box.union(g.boundingBox);
    }
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const scale = TARGET_SIZE / Math.max(size.x, size.y);

    return { geometries, center, scale, size };
  }, []);
}

/** Drag-to-spin feel. */
const DRAG_SPEED = 0.009; // radians of spin per pixel dragged
const TOUCH_DRAG_SPEED = 0.018;
const MOMENTUM_DECAY = 0.92; // per-frame velocity falloff after release (flick coast)
const RETURN_HOME = 0.75; // base of the per-second ease back to the rest pose
const MATERIAL_COLOR_FADE = 0.52; // seconds to visually land the glass body on a new palette
const MATERIAL_COLOR_EPSILON = 0.001;

type TransmissionMaterial = THREE.MeshPhysicalMaterial & {
  attenuationColor: THREE.Color;
};

function colorTarget(hex: string) {
  return new THREE.Color(hex);
}

function colorDistanceSquared(a: THREE.Color, b: THREE.Color) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

function dampColor(current: THREE.Color, target: THREE.Color, alpha: number) {
  if (colorDistanceSquared(current, target) <= MATERIAL_COLOR_EPSILON * MATERIAL_COLOR_EPSILON) {
    current.copy(target);
    return;
  }
  current.lerp(target, alpha);
}

function GlassMark({ p }: { p: GlassParams }) {
  const { geometries, center, scale, size } = useGlyphGeometries();
  const group = useRef<THREE.Group>(null);
  const pointer = useThree((s) => s.pointer);

  // The ambient pose (rest + hover parallax) and the user's drag spin are kept
  // separate so they compose instead of fighting; the final rotation is base+spin.
  const base = useRef({ x: 0, y: 0 });
  const spin = useRef({ x: 0, y: 0 });
  const drag = useRef({
    active: false,
    lastX: 0,
    lastY: 0,
    vx: 0,
    vy: 0,
    moved: false,
    speed: DRAG_SPEED,
  });
  const materials = useRef<Array<TransmissionMaterial | null>>([]);
  const [materialColors] = useState(() => ({
    bodyColor: colorTarget(p.bodyColor),
    bodyTint: colorTarget(p.bodyTint),
    backdrop: colorTarget(p.backdrop),
    targetBodyColor: colorTarget(p.bodyColor),
    targetBodyTint: colorTarget(p.bodyTint),
    targetBackdrop: colorTarget(p.backdrop),
  }));

  // Keep the color targets in stable holders so palette swaps don't drive
  // per-frame React renders; the useFrame loop fades the live colors toward them.
  useEffect(() => {
    materialColors.targetBodyColor.set(p.bodyColor);
    materialColors.targetBodyTint.set(p.bodyTint);
    materialColors.targetBackdrop.set(p.backdrop);
  }, [materialColors, p.bodyColor, p.bodyTint, p.backdrop]);

  // Drag tracking lives on window so a spin keeps following the cursor even when
  // it leaves the glyph mid-drag; pointer-down is captured on the mesh below.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d.active) return;
      const dx = e.clientX - d.lastX;
      const dy = e.clientY - d.lastY;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      spin.current.y += dx * d.speed;
      spin.current.x += dy * d.speed;
      d.vy = dx * d.speed; // remember last delta for release momentum
      d.vx = dy * d.speed;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    };
    const endDrag = () => {
      if (!drag.current.active) return;
      drag.current.active = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      // Reset any grab/grabbing cursor we set on <body>: if the mark unmounts
      // while hovered or mid-drag (e.g. sign-in advances the wizard), the
      // Three.js pointer-out never fires and the cursor would stay stuck.
      document.body.style.cursor = "";
    };
  }, []);

  useFrame((state, delta) => {
    const g = group.current;
    if (!g) return;
    const d = drag.current;
    const colorAlpha = 1 - 0.001 ** (delta / MATERIAL_COLOR_FADE);

    dampColor(materialColors.bodyColor, materialColors.targetBodyColor, colorAlpha);
    dampColor(materialColors.bodyTint, materialColors.targetBodyTint, colorAlpha);
    dampColor(materialColors.backdrop, materialColors.targetBackdrop, colorAlpha);
    for (const material of materials.current) {
      if (!material) continue;
      material.color.copy(materialColors.bodyColor);
      material.attenuationColor.copy(materialColors.bodyTint);
    }

    // After release: coast on the flick's momentum, then ease the spin gently
    // back home so the mark always settles into its designed pose.
    if (!d.active) {
      d.vx *= MOMENTUM_DECAY;
      d.vy *= MOMENTUM_DECAY;
      spin.current.x += d.vx;
      spin.current.y += d.vy;
      const home = 1 - RETURN_HOME ** delta;
      spin.current.x -= spin.current.x * home;
      spin.current.y -= spin.current.y * home;
    }

    // Ambient: rest pose + a slow idle sway (never dead-still) + a little hover
    // parallax. All frozen while dragging so they don't fight the spin.
    // Amplitude is ~2x the marketing hero's: this mark renders small (~112px vs
    // ~460px), so the same angular wobble moved only a few pixels and read as
    // still. Bigger arcs, SAME frequencies — it drifts more, not faster.
    const t = state.clock.elapsedTime;
    const swayX = d.active ? 0 : Math.sin(t * 0.6) * 0.055;
    const swayY = d.active ? 0 : Math.sin(t * 0.45 + 1.2) * 0.09;
    const tx = p.restX + swayX + (d.active ? 0 : pointer.y * 0.16);
    const ty = p.restY + swayY + (d.active ? 0 : pointer.x * 0.26);
    const k = 1 - 0.001 ** delta;
    base.current.x += (tx - base.current.x) * k;
    base.current.y += (ty - base.current.y) * k;

    g.rotation.x = base.current.x + spin.current.x;
    g.rotation.y = base.current.y + spin.current.y;
  });

  const beginDrag = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const d = drag.current;
    d.active = true;
    d.lastX = e.nativeEvent.clientX;
    d.lastY = e.nativeEvent.clientY;
    d.vx = 0;
    d.vy = 0;
    d.moved = false;
    d.speed = e.nativeEvent.pointerType === "touch" ? TOUCH_DRAG_SPEED : DRAG_SPEED;
    document.body.style.cursor = "grabbing";
  };

  const handlePointerOver = () => {
    if (!drag.current.active) document.body.style.cursor = "grab";
  };

  const handlePointerOut = () => {
    if (!drag.current.active) document.body.style.cursor = "";
  };

  return (
    <Float speed={0.7} rotationIntensity={0.015} floatIntensity={0.12}>
      <group ref={group}>
        {/* SVG space is y-down; flip Y, then center + normalize. */}
        <group
          scale={[scale, -scale, scale]}
          position={[-center.x * scale, center.y * scale, (-EXTRUDE.depth / 2) * scale]}
        >
          {/* The mark has a real empty gap between its bars. A fully transparent
              hit plane covers the normalized SVG bounds so the gap drags like the
              glass itself, without rendering into the transmission pass. */}
          <mesh
            position={[center.x, center.y, HIT_Z]}
            onPointerDown={beginDrag}
            onPointerOver={handlePointerOver}
            onPointerOut={handlePointerOut}
          >
            <planeGeometry args={[size.x + HIT_PADDING * 2, size.y + HIT_PADDING * 2]} />
            <meshBasicMaterial
              transparent
              opacity={0}
              depthWrite={false}
              colorWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
          {geometries.map((geo, i) => (
            <mesh
              key={geo.uuid}
              geometry={geo}
              onPointerDown={beginDrag}
              onPointerOver={handlePointerOver}
              onPointerOut={handlePointerOut}
            >
              <MeshTransmissionMaterial
                ref={(material) => {
                  materials.current[i] = material as TransmissionMaterial | null;
                }}
                // Tuned down for the small (~112px) hero size — the transmission
                // buffers can be cheaper here without losing perceptible quality.
                samples={4}
                resolution={256}
                backsideResolution={128}
                background={materialColors.backdrop}
                transmission={p.transmission}
                ior={p.ior}
                roughness={p.roughness}
                metalness={0}
                reflectivity={p.reflectivity}
                chromaticAberration={p.chromaticAberration}
                thickness={p.thickness}
                attenuationDistance={p.attenuationDistance}
                attenuationColor={materialColors.bodyTint}
                color={materialColors.bodyColor}
                anisotropy={0.1}
                distortion={0.03}
                distortionScale={0.1}
                temporalDistortion={0}
                backside
                backsideThickness={p.backsideThickness}
              />
            </mesh>
          ))}
        </group>
      </group>
    </Float>
  );
}

function applyEnvColors(
  colors: { background: THREE.Color; top: THREE.Color; edge: THREE.Color },
  backgroundColor: THREE.Color | null,
  topMeshes: RefObject<Array<THREE.Mesh | null>>,
  edgeMeshes: RefObject<Array<THREE.Mesh | null>>,
  topIntensity: number,
  keyIntensity: number,
  sideIntensity: number,
) {
  backgroundColor?.copy(colors.background);
  const topScales = [topIntensity, topIntensity * 0.9, keyIntensity * 0.18];
  topMeshes.current?.forEach((mesh, index) => {
    (mesh?.material as THREE.MeshBasicMaterial | undefined)?.color
      .copy(colors.top)
      .multiplyScalar(topScales[index] ?? 1);
  });
  edgeMeshes.current?.forEach((mesh) => {
    (mesh?.material as THREE.MeshBasicMaterial | undefined)?.color
      .copy(colors.edge)
      .multiplyScalar(sideIntensity);
  });
}

/** Cross-fade the theme-dependent backdrop and rim colors inside one mounted
 * environment. Keeping it mounted lets reflections glide instead of sticking
 * for a beat and snapping when a freshly baked environment replaces them. */
function EnvironmentThemeFade({
  background,
  top,
  edge,
  live,
  onSettled,
  topMeshes,
  edgeMeshes,
  topIntensity,
  keyIntensity,
  sideIntensity,
}: {
  background: string;
  top: string;
  edge: string;
  live: boolean;
  onSettled: () => void;
  topMeshes: RefObject<Array<THREE.Mesh | null>>;
  edgeMeshes: RefObject<Array<THREE.Mesh | null>>;
  topIntensity: number;
  keyIntensity: number;
  sideIntensity: number;
}) {
  const backgroundRef = useRef<THREE.Color | null>(null);
  const [colors] = useState(() => ({
    background: colorTarget(background),
    top: colorTarget(top),
    edge: colorTarget(edge),
    targetBackground: colorTarget(background),
    targetTop: colorTarget(top),
    targetEdge: colorTarget(edge),
  }));
  const [initialBackground] = useState(background);
  const settled = useRef(false);

  useLayoutEffect(() => {
    colors.targetBackground.set(background);
    colors.targetTop.set(top);
    colors.targetEdge.set(edge);
    if (!live) {
      colors.background.copy(colors.targetBackground);
      colors.top.copy(colors.targetTop);
      colors.edge.copy(colors.targetEdge);
      applyEnvColors(
        colors,
        backgroundRef.current,
        topMeshes,
        edgeMeshes,
        topIntensity,
        keyIntensity,
        sideIntensity,
      );
    }
  }, [
    background,
    colors,
    edge,
    edgeMeshes,
    keyIntensity,
    live,
    sideIntensity,
    top,
    topIntensity,
    topMeshes,
  ]);

  useEffect(() => {
    if (live) settled.current = false;
  }, [live]);

  useFrame((_, delta) => {
    if (!live) return;
    const alpha = 1 - 0.001 ** (delta / ENV_THEME_FADE);
    dampColor(colors.background, colors.targetBackground, alpha);
    dampColor(colors.top, colors.targetTop, alpha);
    dampColor(colors.edge, colors.targetEdge, alpha);
    applyEnvColors(
      colors,
      backgroundRef.current,
      topMeshes,
      edgeMeshes,
      topIntensity,
      keyIntensity,
      sideIntensity,
    );
    if (
      !settled.current &&
      colors.background.equals(colors.targetBackground) &&
      colors.top.equals(colors.targetTop) &&
      colors.edge.equals(colors.targetEdge)
    ) {
      settled.current = true;
      onSettled();
    }
  });

  return <color ref={backgroundRef} attach="background" args={[initialBackground]} />;
}

/** The lazy-loaded glass canvas. Palette and theme changes fade live;
 * decorative — aria-hidden. */
export default function GlassMarkCanvas({ palette }: { palette: GlassPalette }) {
  const isDark = useIsDark();
  const base = useMemo<GlassParams>(() => ({ ...GLASS_DEFAULTS, ...palette }), [palette]);
  const p = useMemo<GlassParams>(() => {
    if (!isDark) return base;
    const dark = { chromaScale: DARK_CHROMA_SCALE, lightnessLift: DARK_LIGHTNESS_LIFT };
    return {
      ...base,
      bodyColor: adjustOklch(base.bodyColor, dark),
      bodyTint: adjustOklch(base.bodyTint, dark),
      backdrop: adjustOklch(base.backdrop, dark),
      edgeColor: adjustOklch(base.edgeColor, dark),
      topColor: adjustOklch(base.topColor, dark),
    };
  }, [base, isDark]);

  // Fade the canvas in only once it has drawn a few real frames (see RevealGate).
  const [ready, setReady] = useState(false);

  // Stop rendering entirely while off-screen or the window is hidden.
  const wrapRef = useRef<HTMLDivElement>(null);
  const active = useRenderActive(wrapRef);

  // Theme flips temporarily rebake the environment every frame so its reflected
  // colors track the lerp. If the mark is hidden, land immediately instead.
  const [envFading, setEnvFading] = useState(false);
  const [previousDark, setPreviousDark] = useState(isDark);
  if (previousDark !== isDark) {
    setPreviousDark(isDark);
    if (active) setEnvFading(true);
  }
  const settleEnv = useCallback(() => setEnvFading(false), []);

  const topLightRefs = useRef<Array<THREE.Mesh | null>>([]);
  const edgeLightRefs = useRef<Array<THREE.Mesh | null>>([]);
  const envKey = useMemo(
    () =>
      [
        RIG_VERSION,
        base.edgeColor,
        base.topColor,
        base.streakColor,
        base.envLight,
        base.envDark,
      ].join("|"),
    [base],
  );

  return (
    <div
      ref={wrapRef}
      aria-hidden
      // touch-action:none so a touch-drag spins the mark instead of scrolling.
      // A quick crossfade only masks the placeholder to glass swap and frame
      // gate, so the mark reads as loading with the content rather than later.
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        touchAction: "none",
        transition: "opacity 220ms ease-out",
        opacity: ready ? 1 : 0,
      }}
    >
      <Canvas
        // "always" while visible (continuous idle sway); "never" pauses the loop
        // dead when off-screen/hidden so the costly transmission buffers stop.
        frameloop={active ? "always" : "never"}
        gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
        dpr={[1, 2]}
        style={{ background: "transparent" }}
      >
        <RevealGate onReady={() => setReady(true)} />
        <CameraRig viewSize={p.viewSize} perspective={p.perspective} />

        <ambientLight intensity={p.ambient} />

        <GlassMark p={p} />

        <Environment key={envKey} resolution={256} frames={envFading ? Infinity : 1}>
          {/* Warm rims TOP + BOTTOM, balanced — a matching bottom rim means both
              bars catch the same light and read as the same color. Pulled behind
              the mark (z<0) so they rim the bevels rather than washing the face. */}
          <Lightformer
            ref={(mesh: THREE.Mesh | null) => {
              topLightRefs.current[0] = mesh;
            }}
            form="rect"
            intensity={base.topIntensity}
            color={base.topColor}
            position={[0, 5, -0.5]}
            scale={[10, 4, 1]}
          />
          <Lightformer
            ref={(mesh: THREE.Mesh | null) => {
              topLightRefs.current[1] = mesh;
            }}
            form="rect"
            intensity={base.topIntensity * 0.9}
            color={base.topColor}
            position={[0, -5, -0.5]}
            scale={[10, 4, 1]}
          />
          {/* Soft, dead-centered FRONT FILL (head-on sheen) — large + centered so
              the flat face reflects a near-constant value as it tilts. */}
          <Lightformer
            ref={(mesh: THREE.Mesh | null) => {
              topLightRefs.current[2] = mesh;
            }}
            form="rect"
            intensity={base.keyIntensity * 0.18}
            color={base.topColor}
            position={[0, 0, 6]}
            scale={[14, 14, 1]}
          />
          {/* Edge glow sits at the mark's depth so it lights the bevels while
              staying out of the flat front's reflection cone. */}
          <Lightformer
            ref={(mesh: THREE.Mesh | null) => {
              edgeLightRefs.current[0] = mesh;
            }}
            form="rect"
            intensity={base.sideIntensity}
            color={base.edgeColor}
            position={[-5, -1, 0]}
            scale={[5, 9, 1]}
          />
          <Lightformer
            ref={(mesh: THREE.Mesh | null) => {
              edgeLightRefs.current[1] = mesh;
            }}
            form="rect"
            intensity={base.sideIntensity}
            color={base.edgeColor}
            position={[5, 1, 0]}
            scale={[5, 9, 1]}
          />
          {/* Narrow forward streaks sweep as thin lines across the face. */}
          <Lightformer
            form="rect"
            intensity={base.streakIntensity}
            color={base.streakColor}
            position={[-1.5, 1.5, 5]}
            rotation={[0, 0, 0.5]}
            scale={[0.4, 5, 1]}
          />
          <Lightformer
            form="rect"
            intensity={base.streakIntensity * 0.7}
            color={base.streakColor}
            position={[1.8, -0.5, 5]}
            rotation={[0, 0, 0.4]}
            scale={[0.3, 4, 1]}
          />
          {/* Last so its layout effect overwrites the Lightformers' initial color
              writes before the environment's first bake. */}
          <EnvironmentThemeFade
            background={isDark ? base.envDark : base.envLight}
            top={p.topColor}
            edge={p.edgeColor}
            live={envFading}
            onSettled={settleEnv}
            topMeshes={topLightRefs}
            edgeMeshes={edgeLightRefs}
            topIntensity={base.topIntensity}
            keyIntensity={base.keyIntensity}
            sideIntensity={base.sideIntensity}
          />
        </Environment>
      </Canvas>
    </div>
  );
}
