import { playAgentSound } from "./agent-sounds";
import { playRecordingSound } from "./recording-sounds";

export type ClovySoundsDemoApi = {
  dispose: () => void;
};

type ClovySoundsDemoCommand =
  | "all"
  | "recording"
  | "agent"
  | "start"
  | "pause"
  | "stop"
  | "ready"
  | "needsInput";

const HELP = [
  "Clovy sound family:",
  '  __clovySounds("all")         recording and agent cues in sequence',
  '  __clovySounds("recording")   start, pause, stop',
  '  __clovySounds("agent")       ready, needs input',
  '  __clovySounds("start")       recording started',
  '  __clovySounds("pause")       recording paused',
  '  __clovySounds("stop")        recording stopped',
  '  __clovySounds("ready")       agent run settled',
  '  __clovySounds("needsInput")  agent needs attention',
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

export function registerClovySoundsDemo(): ClovySoundsDemoApi {
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

  const run = (command?: ClovySoundsDemoCommand) => {
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

  (window as unknown as { __clovySounds?: typeof run }).__clovySounds = run;

  return {
    dispose() {
      cancelSequence();
      (window as unknown as { __clovySounds?: typeof run }).__clovySounds = undefined;
    },
  };
}
