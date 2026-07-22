import { IconArrowDown } from "central-icons/IconArrowDown";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { type RefObject, useCallback, useEffect, useState } from "react";
import type { AgentChatPart, AgentChatTurn } from "../../../lib/agent-chat-runtime";
import type { AgentChatGallerySection } from "../../../lib/agent-chat-gallery";
import type { FundingTier } from "../../account/FundingNotice";
import { AgentChatTurnRow } from "./AgentChatTurnRow";

export function chatTurnsSignature(turns: AgentChatTurn[]) {
  return turns.reduce(
    (total, turn) =>
      total +
      1 +
      turn.parts.reduce(
        (size, part) =>
          size + 1 + ("text" in part && typeof part.text === "string" ? part.text.length : 0),
        0,
      ),
    0,
  );
}

// Deliberate-tooltip delay for the icon-only turn actions, matching the tab
// bar's shortcut tips — slower than the shared hover-intent debounce so
// sweeping across the row doesn't pop a trail of labels.
const AGENT_TRANSCRIPT_BOTTOM_THRESHOLD_PX = 48;

export function agentComposerClearance(scrollerBottom: number, composerTop: number) {
  return Math.max(0, Math.ceil(scrollerBottom - composerTop));
}

export function isAgentTranscriptNearBottom(scroller: HTMLElement) {
  return (
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <=
    AGENT_TRANSCRIPT_BOTTOM_THRESHOLD_PX
  );
}

// Self-contained so scroll-driven visibility never re-renders the huge
// AgentWorkspace: only this leaf flips on its own scroll + resize signals.
// While the reader is parked up-thread, streamed turns grow the content
// WITHOUT firing a scroll event, so the ResizeObserver watches the content
// column (not just the scroller) to catch that growth.
export function AgentScrollToLatestButton({
  scrollRef,
  onJump,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  onJump: () => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const recheck = () => {
      const nothingToScroll = scroller.scrollHeight <= scroller.clientHeight;
      const next = !nothingToScroll && !isAgentTranscriptNearBottom(scroller);
      setVisible((current) => (current === next ? current : next));
    };
    recheck();
    scroller.addEventListener("scroll", recheck, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(recheck) : undefined;
    observer?.observe(scroller);
    // The scroller box itself never resizes when content grows (fixed height,
    // overflow scroll), so watch its children — all of them, not a presumed
    // single content column — since their growth is what moves scrollHeight.
    for (const child of Array.from(scroller.children)) observer?.observe(child);
    return () => {
      scroller.removeEventListener("scroll", recheck);
      observer?.disconnect();
    };
  }, [scrollRef]);

  return (
    <button
      type="button"
      className="agent-scroll-to-latest"
      data-visible={visible ? "true" : undefined}
      aria-label="Scroll to latest"
      aria-hidden={visible ? undefined : true}
      tabIndex={visible ? undefined : -1}
      onClick={onJump}
    >
      <IconArrowDown size={16} ariaHidden />
    </button>
  );
}

// Collapse runs of "thinking-only" assistant turns (reasoning/tool, no answer
// text) into the next answer turn, so a back-to-back chain of thoughts shows as
// a single "Thought" disclosure rather than several stacked in a row.
export function mergeThinkingTurns(turns: AgentChatTurn[]): AgentChatTurn[] {
  const isThinkingOnly = (turn: AgentChatTurn): boolean =>
    turn.role === "assistant" &&
    turn.parts.length > 0 &&
    turn.parts.every((part) => part.type === "reasoning" || part.type === "tool");
  const rebuild = (turn: AgentChatTurn, parts: AgentChatPart[]): AgentChatTurn => ({
    id: turn.id,
    branchMessageId: turn.branchMessageId,
    role: turn.role,
    createdAt: turn.createdAt,
    status: turn.status,
    parts,
  });

  const out: AgentChatTurn[] = [];
  let pending: AgentChatTurn | undefined;
  for (const turn of turns) {
    if (isThinkingOnly(turn)) {
      pending = pending === undefined ? turn : rebuild(turn, [...pending.parts, ...turn.parts]);
      continue;
    }
    if (turn.role === "assistant" && pending !== undefined) {
      out.push(rebuild(turn, [...pending.parts, ...turn.parts]));
      pending = undefined;
      continue;
    }
    if (pending !== undefined) {
      out.push(pending);
      pending = undefined;
    }
    out.push(turn);
  }
  if (pending !== undefined) out.push(pending);
  return out;
}

// Dev-only catalog of every agent response part type, rendered through the real
// <AgentChatTurnRow> so the styling shown is exactly what ships. Toggled from the
// console via window.__agentGallery(). Handlers are no-ops — it's a static
// styling reference, not a live conversation. Module-level so the reference is
// stable across renders.
export const galleryNoop = () => {};

const SHIMMER_GALLERY_SAMPLES = [
  { length: "Short", text: "Thinking…" },
  { length: "Medium", text: "Generating image…" },
  { length: "Long", text: "Generating video, this can take a minute" },
] as const;

function AgentShimmerGallerySection() {
  return (
    <section className="agent-gallery-section agent-gallery-shimmer-section">
      <header className="agent-gallery-section-header">
        <h3>Shimmer text lengths</h3>
        <p>
          Each sample uses the production color, spread, and 1.6-second cadence. Compare perceived
          speed and contrast across text lengths in the active theme.
        </p>
      </header>
      <dl className="agent-gallery-shimmer-list">
        {SHIMMER_GALLERY_SAMPLES.map((sample) => (
          <div key={sample.length} className="agent-gallery-shimmer-sample">
            <dt>{sample.length}</dt>
            <dd>
              <span className="text-shimmer shimmer agent-gallery-shimmer-text">{sample.text}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function AgentResponseGallery({
  sections,
  errors,
  fundingTier,
  onClose,
}: {
  sections: AgentChatGallerySection[];
  errors?: boolean;
  fundingTier?: FundingTier;
  onClose: () => void;
}) {
  const [thinkingOpenByKey, setThinkingOpenByKey] = useState<Record<string, boolean>>({});
  const [upstreamFailureRetryAttempts, setUpstreamFailureRetryAttempts] = useState<
    Record<string, true>
  >({});
  const setThinkingOpen = useCallback((key: string, open: boolean) => {
    setThinkingOpenByKey((current) =>
      current[key] === open ? current : { ...current, [key]: open },
    );
  }, []);
  return (
    <div className="agent-timeline agent-gallery">
      <div className="agent-gallery-banner">
        <div>
          <strong>{errors ? "Agent error gallery" : "Agent response gallery"}</strong>
          <p>
            {errors
              ? "Every error surface in agent chat. The banner above and the composer notice below are forced samples too."
              : "Every response part type and status, for styling."}{" "}
            Close from the console with{" "}
            <code>{errors ? "__agentErrors" : "__agentGallery"}(false)</code>.
          </p>
        </div>
        <button
          type="button"
          className="agent-icon-button"
          aria-label="Close gallery"
          onClick={onClose}
        >
          <IconCrossMedium size={15} />
        </button>
      </div>
      {errors ? null : <AgentShimmerGallerySection />}
      {sections.map((section) => (
        <section key={section.label} className="agent-gallery-section">
          <header className="agent-gallery-section-header">
            <h3>{section.label}</h3>
            {section.description ? <p>{section.description}</p> : null}
          </header>
          {section.turns.map((turn) => (
            <AgentChatTurnRow
              key={turn.id}
              turn={turn}
              artifacts={section.artifacts}
              approvalSubmitting={{}}
              clarifySubmitting={{}}
              sudoSubmitting={{}}
              secretSubmitting={{}}
              thinkingOpen={(key) => thinkingOpenByKey[key] ?? false}
              onApproval={galleryNoop}
              onClarify={galleryNoop}
              onSudo={galleryNoop}
              onSecret={galleryNoop}
              onDownloadArtifact={galleryNoop}
              onRetryUpstreamFailure={(turnId) =>
                setUpstreamFailureRetryAttempts((current) => ({ ...current, [turnId]: true }))
              }
              upstreamFailureRetryAttempted={Boolean(upstreamFailureRetryAttempts[turn.id])}
              onThinkingOpenChange={setThinkingOpen}
              onTopUp={galleryNoop}
              fundingTier={fundingTier}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
