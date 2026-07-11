import { Component, type ReactNode, Suspense, lazy, useMemo, useSyncExternalStore } from "react";
import { useBrandId } from "../../lib/brand";
import { GLASS_PALETTES } from "../../lib/brand-glass";
import { JuneGradientMark } from "../account/AccountGate";

// The 3D glass June mark for the sign-in / welcome surfaces. This wrapper stays
// in the main bundle and is deliberately light: it decides WHETHER to attempt
// the WebGL mark at all, and lazy-loads the heavy three.js canvas only when it
// will. In every degraded case (reduced motion, no WebGL, slow load, render
// failure) it falls back to the flat gradient mark with NO layout shift — the
// outer box reserves the same square either way.

// Only ever imported through React.lazy, so three.js splits into its own chunk
// and never touches the app's initial load.
const GlassMarkCanvas = lazy(() => import("./glass-mark-canvas"));

/** True once we've confirmed the browser can actually create a WebGL context.
 *  Computed lazily and cached; in jsdom / a WebGL-less environment this is false,
 *  so we never even import the three.js chunk and just show the static mark. */
let webglSupport: boolean | undefined;
function hasWebGL(): boolean {
  if (webglSupport !== undefined) return webglSupport;
  // WebGL-less browsers and DOM implementations such as jsdom do not expose
  // the context constructor. Bail out before calling getContext: jsdom reports
  // unsupported canvas APIs to stderr instead of throwing, which otherwise
  // makes every surface containing the mark emit noisy errors.
  // Do not cache the server-side answer: hydration may run in a WebGL-capable
  // browser after an SSR pass without a document.
  if (typeof document === "undefined") return false;
  if (typeof globalThis.WebGLRenderingContext === "undefined") {
    webglSupport = false;
    return webglSupport;
  }
  try {
    const canvas = document.createElement("canvas");
    webglSupport = !!(
      canvas.getContext("webgl2") ||
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl")
    );
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

// prefers-reduced-motion, live. When reduced, we render the static mark and skip
// the glass entirely — that's the simplest correct answer here (the mark's whole
// point is idle motion + drag), and it also spares the GPU cost.
function subscribeReducedMotion(onChange: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
const reducedMotionSnapshot = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, reducedMotionSnapshot, () => false);
}

/** Falls back to the static mark if the WebGL canvas throws while rendering
 *  (lost context, driver failure, etc.) instead of taking the screen down. */
class GlassErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  {
    failed: boolean;
  }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

/**
 * The brand-themed 3D glass June mark. Sizes to its container (give the wrapping
 * element a fixed square, e.g. `.welcome-mark-glass`). Decorative: aria-hidden.
 */
export function JuneGlassMark() {
  const brandId = useBrandId();
  const reducedMotion = usePrefersReducedMotion();
  const palette = useMemo(() => GLASS_PALETTES[brandId], [brandId]);

  // The graceful-degradation mark — identical footprint to the glass canvas, so
  // swapping between them never shifts layout.
  const fallback = <JuneGradientMark />;

  if (reducedMotion || !hasWebGL()) return fallback;

  return (
    <GlassErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <GlassMarkCanvas palette={palette} />
      </Suspense>
    </GlassErrorBoundary>
  );
}
