import { playAgentSound } from "./agent-sounds";
import { playRecordingSound } from "./recording-sounds";

export type JuneSoundsDemoApi = {
  dispose: () => void;
};

type JuneSoundsDemoCommand =
  | "all"
  | "recording"
  | "agent"
  | "start"
  | "pause"
  | "stop"
  | "ready"
  | "needsInput";

const HELP = [
  "June sound family:",
  '  __juneSounds("all")         recording and agent cues in sequence',
  '  __juneSounds("recording")   start, pause, stop',
  '  __juneSounds("agent")       ready, needs input',
  '  __juneSounds("start")       recording started',
  '  __juneSounds("pause")       recording paused',
  '  __juneSounds("stop")        recording stopped',
  '  __juneSounds("ready")       agent run settled',
  '  __juneSounds("needsInput")  agent needs attention',
].join("\n");

const RECORDING_SEQUENCE = [
  { delayMs: 0, play: () => playRecordingSound("start") },
  { delayMs: 900, play: () => playRecordingSound("pause") },
  { delayMs: 1800, play: () => playRecordingSound("stop") },
] as const;

const AGENT_SEQUENCE = [
  { delayMs: 0, play: () => playAgentSound("ready") },
  { delayMs: 1000, play: () => playAgentSound("needsInput") },
] as const;

export function registerJuneSoundsDemo(): JuneSoundsDemoApi {
  let timers: number[] = [];

  function cancelSequence() {
    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
  }

  function playSequence(sequence: ReadonlyArray<{ delayMs: number; play: () => unknown }>) {
    cancelSequence();
    for (const step of sequence) {
      if (step.delayMs === 0) {
        step.play();
      } else {
        timers.push(window.setTimeout(step.play, step.delayMs));
      }
    }
  }

  const run = (command?: JuneSoundsDemoCommand) => {
    switch (command) {
      case "all":
        playSequence([
          ...RECORDING_SEQUENCE,
          ...AGENT_SEQUENCE.map((step) => ({ ...step, delayMs: step.delayMs + 2800 })),
        ]);
        return "Playing all five cues: recording first, then agent.";
      case "recording":
        playSequence(RECORDING_SEQUENCE);
        return "Playing recording start, pause, and stop.";
      case "agent":
        playSequence(AGENT_SEQUENCE);
        return "Playing agent ready and needs input.";
      case "start":
      case "pause":
      case "stop":
        cancelSequence();
        playRecordingSound(command);
        return `Playing recording ${command}.`;
      case "ready":
        cancelSequence();
        playAgentSound("ready");
        return "Playing agent ready.";
      case "needsInput":
        cancelSequence();
        playAgentSound("needsInput");
        return "Playing agent needs input.";
      default:
        cancelSequence();
        return HELP;
    }
  };

  (window as unknown as { __juneSounds?: typeof run }).__juneSounds = run;

  return {
    dispose() {
      cancelSequence();
      (window as unknown as { __juneSounds?: typeof run }).__juneSounds = undefined;
    },
  };
}
