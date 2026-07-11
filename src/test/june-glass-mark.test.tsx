import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JuneGlassMark } from "../components/brand/JuneGlassMark";

// jsdom has no WebGL, so JuneGlassMark's WebGL probe fails and it renders the
// static gradient fallback instead of ever loading the three.js chunk. This
// asserts that graceful-degradation path — exactly what a WebGL-less or slow
// environment gets — renders a visible June mark with no thrown error.
describe("JuneGlassMark", () => {
  it("renders the static fallback mark when WebGL is unavailable", () => {
    render(<JuneGlassMark />);
    // The fallback is the flat JuneGradientMark: an <svg> titled "June".
    expect(screen.getByTitle("June")).toBeInTheDocument();
  });
});
