import { describe, expect, it } from "vitest";
import { moveItem } from "./reorder";

describe("moveItem", () => {
  it("moves an item forward", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item backward", () => {
    expect(moveItem(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("is a no-op when fromIndex === toIndex", () => {
    const items = ["a", "b", "c"];
    expect(moveItem(items, 1, 1)).toBe(items);
  });

  it("does not mutate the input array", () => {
    const items = ["a", "b", "c"];
    moveItem(items, 0, 2);
    expect(items).toEqual(["a", "b", "c"]);
  });

  it("returns the input unchanged for an out-of-range fromIndex", () => {
    const items = ["a", "b"];
    expect(moveItem(items, 5, 0)).toBe(items);
    expect(moveItem(items, -1, 0)).toBe(items);
  });

  it("returns the input unchanged for an out-of-range toIndex", () => {
    const items = ["a", "b"];
    expect(moveItem(items, 0, 5)).toBe(items);
    expect(moveItem(items, 0, -1)).toBe(items);
  });
});
