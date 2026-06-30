// Dev-only console driver for the transcription progress indicator that shows
// in a meeting note while its audio is being processed:
//
//   window.__processingDemo("validating")    park at the Audio stage
//   window.__processingDemo("transcribing")  park at the Transcript stage
//   window.__processingDemo("generating")    park at the Summary stage
//   window.__processingDemo("transcribing", 3)  ...with 3 recordings queued
//   window.__processingDemo("demo")           scripted Audio -> Summary -> done
//   window.__processingDemo("clear")          finish processing (note -> ready)
//
// It seeds one synthetic note straight into the reducer and selects it, so the
// ProcessingProgressIndicator (note-editor/NoteEditor.tsx) renders in the real
// meeting-notes view with no recording or backend round-trip. The note is
// purely in-memory under PROCESSING_DEMO_NOTE_ID — the status poll skips it,
// and a plain app reload clears it completely. Mirrors the dev drivers in
// lib/global-recorder-demo.ts and lib/dictation-hud-demo.ts.
//
// Never bundled in production: App gates the dynamic import on
// import.meta.env.DEV.

import { PROCESSING_DEMO_NOTE_ID } from "../app/processing-polling";
import type { NoteDto, ProcessingStatus, TranscriptDto } from "./tauri";

export type ProcessingProgressDemoApi = {
  /** Tear down timers and remove the window hook. */
  dispose: () => void;
};

type DemoStage = "validating" | "transcribing" | "generating";

type DemoCommand = DemoStage | "demo" | "finish" | "clear";

// A short two-speaker exchange so the Transcription tab has real turns building
// up alongside the progress bar. Mic + system sources also exercise the
// source filter that appears once both lanes are present.
const TURNS: {
  source: "microphone" | "system";
  startMs: number;
  endMs: number;
  text: string;
}[] = [
  {
    source: "microphone",
    startMs: 0,
    endMs: 6400,
    text: "Thanks for hopping on. Let's run through where the launch stands and what's still open before Friday.",
  },
  {
    source: "system",
    startMs: 6400,
    endMs: 15200,
    text: "The onboarding flow is basically done. I'm still chasing one layout bug on the permissions screen, but the copy and the happy path both look right.",
  },
  {
    source: "microphone",
    startMs: 15200,
    endMs: 21800,
    text: "Good. Can we get that bug into today's build so QA has a full day with it?",
  },
  {
    source: "system",
    startMs: 21800,
    endMs: 30600,
    text: "Yeah, I'll have a fix up within the hour. The only other risk is the analytics events, which still need a review before we trust the dashboard numbers.",
  },
];

// A few different generated notes so each run reveals fresh content — handy for
// watching the wipe-in animation. Headings (##), bullets (-) and **bold** are
// the markdown subset NotePreview actually renders.
const SAMPLE_GENERATED_NOTES = [
  [
    "## Summary",
    "",
    "Launch review for Friday. Onboarding is close to done; one permissions-screen layout bug remains and will land in today's build for QA. Analytics events still need a review before the dashboard numbers can be trusted.",
    "",
    "## Decisions",
    "",
    "- Ship the permissions-screen fix in today's build so QA gets a full day with it.",
    "- Hold the launch at Friday, pending the analytics review.",
    "",
    "## Action items",
    "",
    "- **Maya** to land the permissions layout fix within the hour.",
    "- **Dev** to review the analytics events before end of day.",
    "- **Andrew** to confirm the dashboard numbers tomorrow morning.",
  ],
  [
    "## Key points",
    "",
    "- Q3 roadmap is anchored on notes export and faster transcription.",
    "- The new recording pill tested well; only the orientation animation needs polish.",
    "- Support load is down since the onboarding rewrite.",
    "",
    "## Risks",
    "",
    "- Transcription latency spikes on long meetings are still unresolved.",
    "- The export format is undecided between Markdown and PDF.",
    "",
    "## Next steps",
    "",
    "- **Priya** to spec the export format options by Wednesday.",
    "- **Sam** to profile the latency spike with a 90-minute sample.",
  ],
  [
    "## Summary",
    "",
    "Quick sprint sync. Most tickets are on track. The auth refactor slipped a day but is unblocked now and should land tomorrow.",
    "",
    "## Action items",
    "",
    "- Finish the auth refactor and open the PR tomorrow.",
    "- Schedule a design review for the settings redesign.",
    "- Follow up with the vendor about the API rate limits.",
  ],
  [
    "## Context",
    "",
    "Call with the Northwind team about their rollout. They have 40 seats and want SSO before going company-wide.",
    "",
    "## What they asked for",
    "",
    "- SAML SSO with Okta.",
    "- An admin view for managing seats.",
    "- A way to export meeting notes into their wiki.",
    "",
    "## Follow-ups",
    "",
    "- **Andrew** to send the SSO timeline by Friday.",
    "- **Maya** to share the seat-management mockups.",
  ],
].map((lines) => lines.join("\n"));

function pickGeneratedNotes(): string {
  const index = Math.floor(Math.random() * SAMPLE_GENERATED_NOTES.length);
  return SAMPLE_GENERATED_NOTES[index] ?? SAMPLE_GENERATED_NOTES[0];
}

function buildTranscripts(count: number): TranscriptDto[] {
  return TURNS.slice(0, count).map((turn, index) => ({
    id: `${PROCESSING_DEMO_NOTE_ID}-turn-${index}`,
    text: turn.text,
    source: turn.source,
    sourceMode: "microphonePlusSystem",
    startMs: turn.startMs,
    endMs: turn.endMs,
    turnIndex: index,
    status: "succeeded",
  }));
}

// Each stage paints a believable slice of the pipeline: the Audio stage has no
// transcript yet, the Transcript stage shows turns landing one by one, and the
// Summary stage has the full transcript with the notes body still generating.
function buildDemoNote(status: ProcessingStatus, queued = 0): NoteDto {
  const createdAt = "2026-06-30T15:04:00.000Z";
  const updatedAt = "2026-06-30T15:18:00.000Z";
  const transcripts =
    status === "transcribing"
      ? buildTranscripts(3)
      : status === "generating"
        ? buildTranscripts(TURNS.length)
        : [];
  return {
    id: PROCESSING_DEMO_NOTE_ID,
    title: "Weekly product sync",
    preview: "Launch review for Friday",
    processingStatus: status,
    folderIds: [],
    createdAt,
    updatedAt,
    durationMs: 31_000,
    generatedContent: "",
    // No editedContent: the note body resolves as editedContent ?? generated
    // ?? "", and an empty-string editedContent (not nullish) would shadow the
    // generated notes — leaving the body blank with nothing to wipe in.
    sourceTranscripts: transcripts,
    // Land on the Notes tab — the meeting-notes summary, where the indicator
    // and queued badge show. The same indicator renders over the live turns on
    // the Transcription tab.
    activeTab: "notes",
    queuedRecordings: queued,
  };
}

// The note that "clear" leaves behind: processing finished, summary in place.
function buildReadyNote(): NoteDto {
  return {
    ...buildDemoNote("ready"),
    sourceTranscripts: buildTranscripts(TURNS.length),
    generatedContent: pickGeneratedNotes(),
    queuedRecordings: 0,
  };
}

const HELP = [
  "Transcription progress demo (meeting note):",
  '  __processingDemo("validating")     park at the Audio stage',
  '  __processingDemo("transcribing")   park at the Transcript stage',
  '  __processingDemo("generating")     park at the Summary stage',
  '  __processingDemo("transcribing", 3)  ...with 3 recordings queued',
  '  __processingDemo("demo")           scripted Audio -> Summary -> notes reveal',
  '  __processingDemo("finish")         generating -> wipe the generated notes in',
  '  __processingDemo("clear")          finish now (note -> ready, no animation)',
  "",
  "Generated notes are randomized, so demo/finish reveal fresh content each run.",
  "Seeds one in-memory note and selects it. Reload to remove it. Dev only.",
].join("\n");

export function registerProcessingProgressDemo({
  seedNote,
}: {
  /** Add the note (or restage it) and select it on the meeting-notes view. */
  seedNote: (note: NoteDto) => void;
}): ProcessingProgressDemoApi {
  let timers: number[] = [];

  function cancelTimers() {
    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
  }

  function at(delayMs: number, run: () => void) {
    timers.push(window.setTimeout(run, delayMs));
  }

  // Every push re-seeds and re-selects the note, so the indicator shows even
  // after navigating away to another note between commands.
  function pushStage(status: ProcessingStatus, queued = 0) {
    seedNote(
      status === "ready" ? buildReadyNote() : buildDemoNote(status, queued),
    );
  }

  function park(status: DemoStage, queued = 0) {
    cancelTimers();
    pushStage(status, queued);
  }

  function clear() {
    cancelTimers();
    pushStage("ready");
  }

  // Sit on the Summary stage briefly, then hand off to ready so the
  // generating -> ready edge fires the notes wipe-in. Random notes each run.
  function finish() {
    cancelTimers();
    pushStage("generating");
    at(900, () => pushStage("ready"));
    return "Generating, then wiping the notes in (~1s). Watch the reveal.";
  }

  function demo() {
    cancelTimers();
    pushStage("validating");
    at(1800, () => pushStage("transcribing", 2));
    at(3400, () => pushStage("transcribing", 1));
    at(5200, () => pushStage("generating"));
    at(7600, () => pushStage("ready"));
    return "Lifecycle running (~8s): preparing audio, transcribing, generating, then the notes wipe in.";
  }

  const hook = (command?: DemoCommand, queued?: number) => {
    switch (command) {
      case "validating":
        park("validating");
        return 'Parked at the Audio stage. __processingDemo("clear") to finish.';
      case "transcribing":
        park("transcribing", queued ?? 0);
        return `Parked at the Transcript stage${
          queued ? ` with ${queued} queued` : ""
        }. __processingDemo("clear") to finish.`;
      case "generating":
        park("generating", queued ?? 0);
        return 'Parked at the Summary stage. __processingDemo("clear") to finish.';
      case "demo":
        return demo();
      case "finish":
        return finish();
      case "clear":
        clear();
        return "Processing finished. The demo note is now ready; reload to remove it.";
      default:
        return HELP;
    }
  };

  (window as unknown as Record<string, unknown>).__processingDemo = hook;

  function dispose() {
    cancelTimers();
    delete (window as unknown as Record<string, unknown>).__processingDemo;
  }

  return { dispose };
}
