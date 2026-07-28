import { describe, expect, it } from "vitest";
import { mergeCollectionOrder } from "./collection-order";

describe("mergeCollectionOrder", () => {
  it("preserves the saved order when nothing has changed", () => {
    expect(mergeCollectionOrder(["c2", "c1"], ["c1", "c2"])).toEqual(["c2", "c1"]);
  });

  it("drops saved rkeys for collections that no longer exist", () => {
    expect(mergeCollectionOrder(["c1", "deleted", "c2"], ["c1", "c2"])).toEqual(["c1", "c2"]);
  });

  it("appends collections missing from the saved order, in their own order", () => {
    expect(mergeCollectionOrder(["c2"], ["c1", "c2", "c3"])).toEqual(["c2", "c1", "c3"]);
  });

  it("returns all rkeys in fetch order when collectionOrder is empty (first save)", () => {
    expect(mergeCollectionOrder([], ["c1", "c2"])).toEqual(["c1", "c2"]);
  });

  it("de-duplicates a saved order containing the same rkey twice", () => {
    expect(mergeCollectionOrder(["c1", "c1", "c2"], ["c1", "c2"])).toEqual(["c1", "c2"]);
  });

  it("returns an empty array when there are no collections at all", () => {
    expect(mergeCollectionOrder([], [])).toEqual([]);
  });
});
