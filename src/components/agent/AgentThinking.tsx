import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

// Framer transforms require same-shape numeric values, so this mirrors the
// 2px --sp-px token rather than passing that CSS variable into the mixer.
const AGENT_THINKING_OFFSET_PX = 2;

/**
 * Bottom-of-timeline responding affordance. The presence host stays mounted
 * while runtime events have no visible output, preserving the shimmer phase;
 * once output arrives, the label gets a brief handoff instead of disappearing.
 */
export function AgentThinking({ visible }: { visible: boolean }) {
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence initial={false} mode="popLayout">
      {visible ? (
        <motion.div
          key="agent-thinking"
          className="agent-thinking"
          role="status"
          aria-live="polite"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: AGENT_THINKING_OFFSET_PX }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -AGENT_THINKING_OFFSET_PX }}
          transition={{
            // Framer Motion takes seconds; these mirror --t-fast/--t-med.
            duration: reduceMotion ? 0.1 : 0.16,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
          <span className="text-shimmer shimmer agent-thinking-label">Thinking…</span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
