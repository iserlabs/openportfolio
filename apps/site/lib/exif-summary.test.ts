import { describe, expect, it } from "vitest";
import { formatExifSummary } from "./exif-summary";

describe("formatExifSummary", () => {
  it("joins every present field with a middle dot, f/ prefix on fNumber", () => {
    expect(
      formatExifSummary({
        camera: "Sony ILCE-7RM4",
        lens: "FE 85mm F1.8",
        focalLength: "85mm",
        fNumber: "1.8",
        shutterSpeed: "1/500",
        iso: 200,
      }),
    ).toBe("Sony ILCE-7RM4 · FE 85mm F1.8 · 85mm · f/1.8 · 1/500 · ISO 200");
  });

  it("returns an empty string when no fields are present", () => {
    expect(formatExifSummary({})).toBe("");
  });

  it("omits absent fields without leaving stray separators", () => {
    expect(formatExifSummary({ camera: "Fujifilm X-T5", iso: 400 })).toBe("Fujifilm X-T5 · ISO 400");
  });

  it("includes iso: 0 (a valid ISO reading), since it's a present number not an absent field", () => {
    expect(formatExifSummary({ iso: 0 })).toBe("ISO 0");
  });
});
