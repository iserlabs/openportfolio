import { describe, expect, it } from "vitest";
import { buildCollectionFormData } from "./collection-form-data";

const ITEMS = [
  { uri: "at://did:plc:owner/social.opencontent.photograph/p2", cid: "bafyp2" },
  { uri: "at://did:plc:owner/social.opencontent.photograph/p1", cid: "bafyp1" },
];

describe("buildCollectionFormData", () => {
  it("omits rkey when creating a new collection", () => {
    const fd = buildCollectionFormData({ title: "Herons", description: "", items: [] });
    expect(fd.has("rkey")).toBe(false);
  });

  it("sets rkey when editing an existing collection", () => {
    const fd = buildCollectionFormData({ rkey: "abc123", title: "Herons", description: "", items: [] });
    expect(fd.get("rkey")).toBe("abc123");
  });

  it("always sets title", () => {
    const fd = buildCollectionFormData({ title: "Herons", description: "", items: [] });
    expect(fd.get("title")).toBe("Herons");
  });

  it("omits description when empty", () => {
    const fd = buildCollectionFormData({ title: "Herons", description: "", items: [] });
    expect(fd.has("description")).toBe(false);
  });

  it("sets description when non-empty", () => {
    const fd = buildCollectionFormData({ title: "Herons", description: "Shorebirds at low tide", items: [] });
    expect(fd.get("description")).toBe("Shorebirds at low tide");
  });

  it("JSON-encodes items in the given order", () => {
    const fd = buildCollectionFormData({ title: "Herons", description: "", items: ITEMS });
    expect(JSON.parse(fd.get("items") as string)).toEqual(ITEMS);
  });

  it("sets items to '[]' when there are none", () => {
    const fd = buildCollectionFormData({ title: "Herons", description: "", items: [] });
    expect(fd.get("items")).toBe("[]");
  });

  it("omits cover when unset", () => {
    const fd = buildCollectionFormData({ title: "Herons", description: "", items: [] });
    expect(fd.has("cover")).toBe(false);
  });

  it("JSON-encodes cover as a single object when set", () => {
    const fd = buildCollectionFormData({ title: "Herons", description: "", items: ITEMS, cover: ITEMS[0] });
    expect(JSON.parse(fd.get("cover") as string)).toEqual(ITEMS[0]);
  });
});
