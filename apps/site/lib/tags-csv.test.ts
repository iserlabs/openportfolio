import { describe, expect, it } from "vitest";
import { formatTagsCsv, parseTagsCsv } from "./tags-csv";

describe("formatTagsCsv", () => {
  it("joins tags with a comma and space", () => {
    expect(formatTagsCsv(["heron", "shorebird", "low tide"])).toBe("heron, shorebird, low tide");
  });

  it("returns an empty string for no tags", () => {
    expect(formatTagsCsv([])).toBe("");
  });

  it("round-trips through parseTagsCsv", () => {
    const tags = ["a", "b", "c"];
    expect(parseTagsCsv(formatTagsCsv(tags))).toEqual(tags);
  });
});

describe("parseTagsCsv", () => {
  it("splits on commas and trims whitespace", () => {
    expect(parseTagsCsv("heron,  shorebird ,low tide")).toEqual(["heron", "shorebird", "low tide"]);
  });

  it("filters out empty entries from stray/trailing commas", () => {
    expect(parseTagsCsv("heron,,  ,shorebird,")).toEqual(["heron", "shorebird"]);
  });

  it("returns an empty array for an empty or whitespace-only string", () => {
    expect(parseTagsCsv("")).toEqual([]);
    expect(parseTagsCsv("   ")).toEqual([]);
  });
});
