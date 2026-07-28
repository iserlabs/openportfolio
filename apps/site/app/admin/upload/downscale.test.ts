import { describe, expect, it } from "vitest";
import { estimateDownscaleDimensions, parseTooLargeLimitBytes } from "./downscale";

describe("parseTooLargeLimitBytes", () => {
  it("parses a whole-MB limit", () => {
    expect(parseTooLargeLimitBytes("image is too large for this server's upload limit (5MB) — try a smaller export")).toBe(
      5 * 1024 * 1024,
    );
  });

  it("parses a fractional-MB limit", () => {
    expect(parseTooLargeLimitBytes("... upload limit (1.2MB) ...")).toBe(Math.round(1.2 * 1024 * 1024));
  });

  it("returns undefined for the generic (unparseable) too-large message", () => {
    expect(parseTooLargeLimitBytes("image is too large for this server's upload limit — try a smaller export")).toBeUndefined();
  });

  it("returns undefined for an undefined message", () => {
    expect(parseTooLargeLimitBytes(undefined)).toBeUndefined();
  });
});

describe("estimateDownscaleDimensions", () => {
  it("scales both dimensions by the same factor (preserves aspect ratio)", () => {
    // 10MB file, 5MB limit -> pixelScale = min(1, 5*0.85/10) = 0.425 -> linearScale = sqrt(0.425)
    const currentBytes = 10 * 1024 * 1024;
    const maxBytes = 5 * 1024 * 1024;
    const { width, height } = estimateDownscaleDimensions(4000, 3000, currentBytes, maxBytes);
    const expectedScale = Math.sqrt((maxBytes * 0.85) / currentBytes);
    expect(width).toBe(Math.round(4000 * expectedScale));
    expect(height).toBe(Math.round(3000 * expectedScale));
    // aspect ratio preserved to within rounding
    expect(Math.abs(width / height - 4000 / 3000)).toBeLessThan(0.01);
  });

  it("never upscales when currentBytes is already under maxBytes", () => {
    const { width, height } = estimateDownscaleDimensions(2000, 1500, 1024, 10 * 1024 * 1024);
    expect(width).toBe(2000);
    expect(height).toBe(1500);
  });

  it("never scales the shorter edge below MIN_DIMENSION (480), even for a tiny maxBytes", () => {
    const { width, height } = estimateDownscaleDimensions(4000, 3000, 100 * 1024 * 1024, 1);
    expect(Math.min(width, height)).toBeGreaterThanOrEqual(480);
    // aspect ratio still preserved at the floor
    expect(Math.abs(width / height - 4000 / 3000)).toBeLessThan(0.01);
  });

  it("throws on non-positive width/height", () => {
    expect(() => estimateDownscaleDimensions(0, 100, 1000, 500)).toThrow();
    expect(() => estimateDownscaleDimensions(100, -1, 1000, 500)).toThrow();
  });

  it("throws on non-positive currentBytes/maxBytes", () => {
    expect(() => estimateDownscaleDimensions(100, 100, 0, 500)).toThrow();
    expect(() => estimateDownscaleDimensions(100, 100, 1000, 0)).toThrow();
  });

  it("handles a portrait (taller than wide) image, still preserving aspect ratio", () => {
    const currentBytes = 8 * 1024 * 1024;
    const maxBytes = 4 * 1024 * 1024;
    const { width, height } = estimateDownscaleDimensions(3000, 4000, currentBytes, maxBytes);
    expect(Math.abs(width / height - 3000 / 4000)).toBeLessThan(0.01);
  });
});
