import { useEffect } from "react";
import { sampleImageDataUrl, setComposerSteerDemoDesired } from "../agent-dev-tools";
import { runningImageSlashTurns } from "../composer/media-slash-persistence";
import { buildUpNextDemoFollowUps } from "../composer/follow-up-queue";
import type { useAgentSteerDemoDependencies } from "./use-agent-steer-demo-types";

export function useAgentSteerDemo(dependencies: useAgentSteerDemoDependencies) {
  const {
    imageTurnsBySession,
    selectedHermesSessionId,
    selectedHermesSessionIsProvisional,
    setImageTurnsBySession,
    setSteerCardsBySessionId,
    setUpNextDemoFollowUpsBySessionId,
    steerCardSeqRef,
  } = dependencies;

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    const w = window as unknown as Record<string, unknown>;
    w.__steerSubmitDemo = (text = "Focus on the mobile layout first") => {
      if (!selectedHermesSessionId || selectedHermesSessionIsProvisional) {
        return "Open a real session first, then run __steerSubmitDemo().";
      }
      steerCardSeqRef.current += 1;
      const id = `steer-demo-${steerCardSeqRef.current}`;
      setSteerCardsBySessionId((prev) => ({
        ...prev,
        [selectedHermesSessionId]: [...(prev[selectedHermesSessionId] ?? []), { id, text }],
      }));
      return `Tacked a steer card "${text}" onto the composer.`;
    };
    w.__upNextDemo = (show: boolean = true) => {
      if (!selectedHermesSessionId || selectedHermesSessionIsProvisional) {
        return "Open a real session first, then run __upNextDemo().";
      }
      setComposerSteerDemoDesired(show);
      const demoSteers = [
        { id: "steer-up-next-demo", text: "Check the API boundary" },
        { id: "steer-up-next-demo-2", text: "Keep the migration additive" },
      ];
      const demoSteerIds = new Set(demoSteers.map((card) => card.id));
      setSteerCardsBySessionId((prev) => {
        const others = (prev[selectedHermesSessionId] ?? []).filter(
          (card) => !demoSteerIds.has(card.id),
        );
        return {
          ...prev,
          [selectedHermesSessionId]: show ? [...others, ...demoSteers] : others,
        };
      });
      setUpNextDemoFollowUpsBySessionId((current) => ({
        ...current,
        [selectedHermesSessionId]: show ? buildUpNextDemoFollowUps() : [],
      }));
      return show
        ? "Up next preview shown. Run __upNextDemo(false) to hide it."
        : "Up next preview hidden.";
    };
    // __imageGenDemo parks a generating-image turn (the dot-field placeholder)
    // in the selected session so the animation can be judged without paying for
    // a real generation; __imageGenDemo("complete") then flips the parked turn
    // in place (same ids, so the mounted part sees running -> complete) to
    // judge the develop-out-of-the-field reveal. Purely in-memory: never
    // persisted, never retried.
    w.__imageGenDemo = (
      show: boolean | "complete" = true,
      prompt = "Generate an image of a wide, zoomed-out view of people sunbathing along the Rio Grande in New Mexico, painted in the style of Claude Monet. The riverbank is as crowded and lively as a New Jersey beach, creating a striking contrast with the high-desert landscape.",
    ) => {
      if (!selectedHermesSessionId || selectedHermesSessionIsProvisional) {
        return "Open a real session first, then run __imageGenDemo().";
      }
      const turnId = `image-demo:${selectedHermesSessionId}`;
      const startedAt = Date.now();
      if (show === "complete") {
        const parked = (imageTurnsBySession[selectedHermesSessionId] ?? []).some(
          (turn) => turn.id === `${turnId}:assistant`,
        );
        if (!parked) return "Park a turn first with __imageGenDemo(), then complete it.";
        const dataUrl = sampleImageDataUrl("generated-image-demo.png", 480, 480);
        setImageTurnsBySession((current) => ({
          ...current,
          [selectedHermesSessionId]: (current[selectedHermesSessionId] ?? []).map((turn) =>
            turn.id === `${turnId}:assistant`
              ? {
                  ...turn,
                  status: "complete" as const,
                  parts: turn.parts.map((part) =>
                    part.type === "image"
                      ? {
                          ...part,
                          status: "complete" as const,
                          dataUrl,
                          name: "generated-image-demo.png",
                        }
                      : part,
                  ),
                }
              : turn,
          ),
        }));
        return "Completed the demo turn - watch the reveal. __imageGenDemo(false) clears it.";
      }
      setImageTurnsBySession((current) => {
        const others = (current[selectedHermesSessionId] ?? []).filter(
          (turn) => !turn.id.startsWith(turnId),
        );
        return {
          ...current,
          [selectedHermesSessionId]: show
            ? [
                ...others,
                {
                  id: `${turnId}:seed-user`,
                  role: "user" as const,
                  createdAt: new Date(startedAt - 120_000).toISOString(),
                  status: "complete" as const,
                  parts: [
                    {
                      type: "text" as const,
                      text: "I'm putting together a visual concept for a summer scene in New Mexico.",
                      status: "complete" as const,
                    },
                  ],
                },
                {
                  id: `${turnId}:seed-assistant`,
                  role: "assistant" as const,
                  createdAt: new Date(startedAt - 60_000).toISOString(),
                  status: "complete" as const,
                  parts: [
                    {
                      type: "text" as const,
                      text: "What kind of setting and atmosphere would you like the image to have?",
                      status: "complete" as const,
                    },
                  ],
                },
                ...runningImageSlashTurns({
                  id: turnId,
                  prompt,
                  requestId: "image-demo-request",
                  createdAt: new Date(startedAt).toISOString(),
                  imageCreatedAt: new Date(startedAt + 1).toISOString(),
                }),
              ]
            : others,
        };
      });
      return show
        ? 'Parked a generating-image turn. __imageGenDemo("complete") plays the reveal; __imageGenDemo(false) clears.'
        : "Cleared the generating-image demo turn.";
    };
    return () => {
      delete w.__steerSubmitDemo;
      delete w.__upNextDemo;
      delete w.__imageGenDemo;
    };
  }, [selectedHermesSessionId, selectedHermesSessionIsProvisional, imageTurnsBySession]);
}
