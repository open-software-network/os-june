/**
 * Replay helper for the Hermes control plane's recorded fixtures.
 *
 * Feeds raw gateway frames through {@link classifyHermesEvent} and returns the
 * classified {@link JuneHermesEvent}s, in order. It exists so replay tests (and
 * any future debug/trace tooling) can drive the classifier over a recorded
 * stream without re-implementing the loop. It is the same total mapping the live
 * gateway applies — one classified event per frame, never a drop.
 *
 * The fixture shape mirrors what `fixtures/*.json` record: sanitized frames plus
 * provenance metadata (which Hermes version they were captured against, where
 * from). See `fixtures/README.md` for how to record and sanitize new ones.
 */

import type { HermesGatewayEvent } from "../hermes-gateway";
import { classifyHermesEvent } from "./event-classifier";
import type { JuneHermesEvent } from "./events";

/** A recorded stream of raw Hermes frames with provenance, as stored in
 * `fixtures/*.json`. Fields are intentionally permissive: fixtures are data off
 * the wire, captured by hand, and only `frames` is load-bearing for replay. */
export interface HermesReplayFixture {
  /** Stable identifier for the family this fixture covers (matches the file). */
  name: string;
  /** The Hermes release these frames were captured against (e.g. "v2026.6.19").
   * Ties a fixture to a point on the compatibility matrix / upgrade checklist. */
  hermesVersion?: string;
  /** Where the frames were recorded from (e.g. "tui-gateway"). */
  recordedFrom?: string;
  /** Asserts the committed frames have already been run through redaction. */
  sanitized?: boolean;
  /** The raw gateway frames, in arrival order. */
  frames: HermesGatewayEvent[];
}

/** One classified frame paired with its source, so a test can report exactly
 * which frame of which fixture failed an expectation. */
export interface ReplayedFrame {
  /** Zero-based position of the frame within the fixture. */
  index: number;
  /** The raw frame that was classified. */
  raw: HermesGatewayEvent;
  /** The classifier's output for that frame. */
  event: JuneHermesEvent;
}

/** Classifies every frame of a fixture, in order, returning the resulting
 * {@link JuneHermesEvent}s. A thin wrapper over {@link classifyHermesEvent} so
 * callers replay a recorded stream the same way the live gateway would. */
export function replayFixture(fixture: HermesReplayFixture): JuneHermesEvent[] {
  return fixture.frames.map((frame) => classifyHermesEvent(frame));
}

/** Like {@link replayFixture}, but pairs each classified event with its source
 * frame and index for precise, low-noise test diagnostics. */
export function replayFixtureFrames(
  fixture: HermesReplayFixture,
): ReplayedFrame[] {
  return fixture.frames.map((raw, index) => ({
    index,
    raw,
    event: classifyHermesEvent(raw),
  }));
}
