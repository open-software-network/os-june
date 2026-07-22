import { AGENT_GALLERY_EVENT, type AgentGalleryDetail } from "../../lib/agent-events";

// Dev-tools response gallery handle. Registered at module scope so
// __agentGallery() exists from app launch — registering it inside the component
// meant it was undefined unless the Agent view happened to be mounted, which is
// why the command appeared "not to work" from other views. The handle records
// the desired state and broadcasts it; App switches to the Agent view on show,
// and the workspace applies the state on mount or live via the event.
// Dev builds only — the handle never exists in production bundles.
export let galleryDesired: "all" | "errors" | false = false;

export function setGalleryDesired(show: boolean, errors = false) {
  galleryDesired = show ? (errors ? "errors" : "all") : false;
  window.dispatchEvent(
    new CustomEvent<AgentGalleryDetail>(AGENT_GALLERY_EVENT, {
      detail: { show, errors },
    }),
  );
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__agentGallery = (show: boolean = true) => {
    setGalleryDesired(show);
    return show
      ? "Agent response gallery shown. Run __agentGallery(false) to hide."
      : "Agent response gallery hidden.";
  };
  // Error-focused variant: just the failure sections, plus the chrome-level
  // error surfaces (error banner, composer busy notice) the turn-based
  // gallery can't represent.
  (window as unknown as Record<string, unknown>).__agentErrors = (show: boolean = true) => {
    setGalleryDesired(show, true);
    return show
      ? "Agent error gallery shown. Run __agentErrors(false) to hide."
      : "Agent error gallery hidden.";
  };
}

// Dev-tools composer state driver (window.__composerSteerDemo). Forces the open
// session's composer into its "June is working" branch — stop takes the slot,
// and typing swaps it for the steer-send in place — so that interaction can be
// iterated on without an in-flight turn. Open any real session first (the
// branch needs a non-provisional session id). The steer-send click won't reach
// a running turn in this mode; it's a visual harness only.
// Dev builds only — the handle never ships.
export const COMPOSER_STEER_DEMO_EVENT = "june:agent:composer-steer-demo";
export let composerSteerDemoDesired = false;

export function setComposerSteerDemoDesired(show: boolean) {
  composerSteerDemoDesired = show;
  window.dispatchEvent(
    new CustomEvent<{ show: boolean }>(COMPOSER_STEER_DEMO_EVENT, { detail: { show } }),
  );
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__composerSteerDemo = (show: boolean = true) => {
    setComposerSteerDemoDesired(show);
    return show
      ? "Composer parked in June-is-working state. Type to reveal the steer-send; run __composerSteerDemo(false) to release."
      : "Composer steer demo released.";
  };
}

// Dev-tools file viewer seeder (window.__agentFiles). Imports one sample file
// per preview path — markdown (rendered + source toggle), plain text, JSON,
// CSV, code, an image, and a binary blob for the no-preview fallback — into
// the real Hermes workspace, then opens the viewer panel on them. Going
// through import_hermes_bridge_file_bytes means every preview is fetched back
// through the same Tauri commands and path validation a real agent file uses.
// Dev builds only — like the gallery, the handle never ships.
export const AGENT_DEV_FILES_EVENT = "june:agent:dev-files";

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__agentFiles = (show: boolean = true) => {
    window.dispatchEvent(
      new CustomEvent<{ show: boolean }>(AGENT_DEV_FILES_EVENT, {
        detail: { show },
      }),
    );
    return show
      ? "Seeding sample files and opening the viewer (needs an open conversation; repeat runs add numbered copies). Run __agentFiles(false) to clear."
      : "Sample files cleared from the viewer (workspace copies remain).";
  };
}

// Dev-tools streaming replay (window.__streamDemo). Replaces the timeline with
// one assistant turn whose text part replays SAMPLE_MARKDOWN as an append-only
// stream through the real running-part path — SmoothedStreamingMarkdown, word
// fade-in and all — so the reveal cadence can be tuned without coaxing a live
// model into a long answer. Loops until dismissed. Dev builds only — the
// handle never ships.
export const AGENT_STREAM_DEMO_EVENT = "june:agent:stream-demo";
export const STREAM_DEMO_SECTION_LABEL = "Streaming replay";
export type AgentStreamDemoDetail = { show: boolean; charsPerSecond: number };
export let streamDemoDesired: AgentStreamDemoDetail = { show: false, charsPerSecond: 80 };

export function setStreamDemoDesired(show: boolean, charsPerSecond: number) {
  streamDemoDesired = { show, charsPerSecond };
  window.dispatchEvent(
    new CustomEvent<AgentStreamDemoDetail>(AGENT_STREAM_DEMO_EVENT, {
      detail: streamDemoDesired,
    }),
  );
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__streamDemo = (
    show: boolean = true,
    charsPerSecond: number = 80,
  ) => {
    setStreamDemoDesired(show, charsPerSecond);
    return show
      ? "Streaming replay running in the agent view. __streamDemo(true, 200) changes speed; __streamDemo(false) stops."
      : "Streaming replay stopped.";
  };
}

export const SAMPLE_MARKDOWN = `# Quarterly review

A sample document that exercises **bold**, *italic*, ~~strikethrough~~,
\`inline code\`, and [links](https://opensoftware.co).

## Highlights

- Revenue grew 14% quarter over quarter
- Churn fell below 2%
- *Notes* shipped to general availability

## Rollout plan

1. Ship the beta to design partners
2. Collect feedback for two weeks
3. General availability

> Blockquotes hold anything a block can: paragraphs, lists, or code.

### Numbers

| Metric  | Q1   | Q2   |
| ------- | ---- | ---- |
| Revenue | 1.2M | 1.4M |
| Churn   | 2.4% | 1.9% |

---

\`\`\`ts
export function growth(previous: number, current: number) {
  return (current - previous) / previous;
}
\`\`\`
`;

export const SAMPLE_JSON = JSON.stringify(
  {
    report: "quarterly-review",
    quarter: "Q2",
    metrics: { revenue: 1_400_000, churn: 0.019 },
    highlights: ["revenue", "churn", "notes-ga"],
  },
  null,
  2,
);

export const SAMPLE_CSV = `metric,q1,q2
revenue,1200000,1400000
churn,0.024,0.019
seats,310,355
`;

export const SAMPLE_CODE = `import { growth } from "./growth";

export const quarters = [1_200_000, 1_400_000];

export function report() {
  return {
    growth: growth(quarters[0], quarters[1]),
    generatedAt: new Date().toISOString(),
  };
}
`;

export const SAMPLE_TEXT = `Plain-text sample.

No markdown extension, so the viewer shows this as monospace text
rather than a rendered document. Line breaks and    spacing survive.
`;

export function buildSampleArtifactFiles(): { name: string; bytes: Uint8Array }[] {
  const encoder = new TextEncoder();
  // 0xFE/0xFF never appear in UTF-8, so the backend's text preview rejects
  // this and the viewer lands on its no-preview download fallback.
  const binary = new Uint8Array(512).map((_, index) => (index % 2 ? 0xfe : 0xff));
  return [
    { name: "june-sample.md", bytes: encoder.encode(SAMPLE_MARKDOWN) },
    { name: "june-sample.txt", bytes: encoder.encode(SAMPLE_TEXT) },
    { name: "june-sample.json", bytes: encoder.encode(SAMPLE_JSON) },
    { name: "june-sample.csv", bytes: encoder.encode(SAMPLE_CSV) },
    { name: "june-sample.ts", bytes: encoder.encode(SAMPLE_CODE) },
    { name: "june-sample.png", bytes: sampleImageBytes() },
    { name: "june-sample.bin", bytes: binary },
  ];
}

/** Paints a small gradient card on a canvas so the image preview path has a
 * real PNG to chew on, without bundling a fixture. */
export function sampleImageDataUrl(label = "june-sample.png", width = 480, height = 320): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#936862");
    gradient.addColorStop(1, "#f4e3d7");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.fillStyle = "rgba(255, 255, 255, 0.92)";
    context.font = "600 28px sans-serif";
    context.fillText(label, 24, Math.round(height / 2) + 8);
  }
  return canvas.toDataURL("image/png");
}

export function sampleImageBytes(): Uint8Array {
  const base64 = sampleImageDataUrl().split(",")[1] ?? "";
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
