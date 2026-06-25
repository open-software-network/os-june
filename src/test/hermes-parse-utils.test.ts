import { describe, expect, it } from "vitest";
import {
  asRecord,
  finiteNumber,
  nonEmpty,
  nonEmptyString,
  pickNumber,
  pickString,
} from "../lib/hermes-control-plane";

describe("hermes parse utils", () => {
  describe("nonEmpty", () => {
    it("returns the trimmed string when it has content", () => {
      expect(nonEmpty("  hello  ")).toBe("hello");
    });

    it("returns undefined for empty, whitespace, or non-string input", () => {
      expect(nonEmpty("")).toBeUndefined();
      expect(nonEmpty("   ")).toBeUndefined();
      expect(nonEmpty(undefined)).toBeUndefined();
    });
  });

  describe("nonEmptyString", () => {
    it("trims and accepts arbitrary unknown input", () => {
      expect(nonEmptyString("  x  ")).toBe("x");
    });

    it("returns undefined for non-string or blank values", () => {
      expect(nonEmptyString(42)).toBeUndefined();
      expect(nonEmptyString(null)).toBeUndefined();
      expect(nonEmptyString("  ")).toBeUndefined();
    });
  });

  describe("asRecord", () => {
    it("returns plain objects as string-keyed records", () => {
      const obj = { a: 1 };
      expect(asRecord(obj)).toBe(obj);
    });

    it("rejects null, arrays, and primitives", () => {
      expect(asRecord(null)).toBeUndefined();
      expect(asRecord([1, 2])).toBeUndefined();
      expect(asRecord("str")).toBeUndefined();
    });
  });

  describe("finiteNumber", () => {
    it("accepts finite numbers including zero", () => {
      expect(finiteNumber(0)).toBe(0);
      expect(finiteNumber(3.5)).toBe(3.5);
    });

    it("rejects NaN, Infinity, and non-numbers", () => {
      expect(finiteNumber(NaN)).toBeUndefined();
      expect(finiteNumber(Infinity)).toBeUndefined();
      expect(finiteNumber("5")).toBeUndefined();
    });
  });

  describe("pickNumber", () => {
    it("returns the first finite number across containers and keys, in order", () => {
      const nested = { prompt_tokens: 10 };
      const hoisted = { promptTokens: 20 };
      expect(
        pickNumber([nested, hoisted], ["promptTokens", "prompt_tokens"]),
      ).toBe(10);
    });

    it("skips undefined containers and bad values, returns undefined when none match", () => {
      expect(
        pickNumber([undefined, { x: "nope" }], ["x", "y"]),
      ).toBeUndefined();
    });
  });

  describe("pickString", () => {
    it("returns the first non-empty string across containers and keys", () => {
      expect(
        pickString([{ name: "  " }, { label: "found" }], ["name", "label"]),
      ).toBe("found");
    });

    it("returns undefined when no key holds a usable string", () => {
      expect(pickString([{ a: 1 }, undefined], ["a", "b"])).toBeUndefined();
    });
  });
});
