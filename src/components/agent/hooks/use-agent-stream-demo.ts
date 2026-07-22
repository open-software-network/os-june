import { useEffect } from "react";
import {
  AGENT_STREAM_DEMO_EVENT,
  SAMPLE_MARKDOWN,
  STREAM_DEMO_SECTION_LABEL,
  streamDemoDesired,
  type AgentStreamDemoDetail,
} from "../agent-dev-tools";
import type { useAgentStreamDemoDependencies } from "./use-agent-stream-demo-types";

export function useAgentStreamDemo(dependencies: useAgentStreamDemoDependencies) {
  const { setGallerySections } = dependencies;

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const TICK_MS = 90;
    // Irregular-but-deterministic chunk scaling so the replay has the uneven
    // cadence of a real provider without churn between runs.
    const JITTER = [0.4, 1.7, 0.2, 2.3, 1, 0.6, 1.8];
    const apply = ({ show, charsPerSecond }: AgentStreamDemoDetail) => {
      stop();
      if (!show) {
        setGallerySections((prev) =>
          prev?.[0]?.label === STREAM_DEMO_SECTION_LABEL ? null : prev,
        );
        return;
      }
      const text = SAMPLE_MARKDOWN;
      let at = 0;
      let tick = 0;
      let restTicks = 0;
      const seed = (end: number, status: "running" | "complete") =>
        setGallerySections([
          {
            label: STREAM_DEMO_SECTION_LABEL,
            description: `Replaying ~${charsPerSecond} chars/s on loop. __streamDemo(false) stops.`,
            turns: [
              {
                id: "gallery:stream-demo",
                role: "assistant",
                createdAt: "2026-06-09T12:00:00.000Z",
                status,
                parts: [{ type: "text", text: text.slice(0, end), status }],
              },
            ],
          },
        ]);
      seed(0, "running");
      timer = window.setInterval(() => {
        if (restTicks > 0) {
          restTicks -= 1;
          if (restTicks === 0) {
            at = 0;
            seed(0, "running");
          }
          return;
        }
        tick += 1;
        const step = Math.round(((charsPerSecond * TICK_MS) / 1000) * JITTER[tick % JITTER.length]);
        at = Math.min(text.length, at + Math.max(1, step));
        const done = at >= text.length;
        seed(at, done ? "complete" : "running");
        if (done) restTicks = Math.round(2000 / TICK_MS);
      }, TICK_MS);
    };
    apply(streamDemoDesired);
    const onDemo = (event: Event) => apply((event as CustomEvent<AgentStreamDemoDetail>).detail);
    window.addEventListener(AGENT_STREAM_DEMO_EVENT, onDemo);
    return () => {
      window.removeEventListener(AGENT_STREAM_DEMO_EVENT, onDemo);
      stop();
    };
  }, []);
}
