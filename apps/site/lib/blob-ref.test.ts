import { describe, expect, it } from "vitest";
import { blobRefCid } from "./blob-ref";

describe("blobRefCid", () => {
  it("extracts the $link string from a wire-format blob ref", () => {
    expect(blobRefCid({ $link: "bafyreiabc123" })).toBe("bafyreiabc123");
  });

  it("returns undefined for a ref missing $link", () => {
    expect(blobRefCid({})).toBeUndefined();
  });

  it("returns undefined for an empty-string $link", () => {
    expect(blobRefCid({ $link: "" })).toBeUndefined();
  });

  it("returns undefined for a non-string $link", () => {
    expect(blobRefCid({ $link: 123 })).toBeUndefined();
  });

  it("returns undefined for null/undefined/primitive refs", () => {
    expect(blobRefCid(null)).toBeUndefined();
    expect(blobRefCid(undefined)).toBeUndefined();
    expect(blobRefCid("bafyreiabc123")).toBeUndefined();
  });
});
