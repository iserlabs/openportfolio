import { describe, expect, it } from "vitest";
import { buildSiteFormData } from "./site-form-data";

const BASE = { title: "Kevin Lee Photography", about: "", theme: "", collectionOrder: [], links: [] };

describe("buildSiteFormData", () => {
  it("always sets title", () => {
    const fd = buildSiteFormData(BASE);
    expect(fd.get("title")).toBe("Kevin Lee Photography");
  });

  it("omits about and theme when empty", () => {
    const fd = buildSiteFormData(BASE);
    expect(fd.has("about")).toBe(false);
    expect(fd.has("theme")).toBe(false);
  });

  it("sets about and theme when non-empty", () => {
    const fd = buildSiteFormData({ ...BASE, about: "Wildlife and travel photography.", theme: "dark" });
    expect(fd.get("about")).toBe("Wildlife and travel photography.");
    expect(fd.get("theme")).toBe("dark");
  });

  it("JSON-encodes collectionOrder, even when empty", () => {
    expect(JSON.parse(buildSiteFormData(BASE).get("collectionOrder") as string)).toEqual([]);
    expect(JSON.parse(buildSiteFormData({ ...BASE, collectionOrder: ["c2", "c1"] }).get("collectionOrder") as string)).toEqual([
      "c2",
      "c1",
    ]);
  });

  it("JSON-encodes only fully-filled-in links", () => {
    const fd = buildSiteFormData({
      ...BASE,
      links: [
        { label: "Instagram", uri: "https://instagram.com/kevin" },
        { label: "", uri: "https://example.com" },
        { label: "Empty uri", uri: "" },
        { label: "  ", uri: "  " },
      ],
    });
    expect(JSON.parse(fd.get("links") as string)).toEqual([{ label: "Instagram", uri: "https://instagram.com/kevin" }]);
  });

  it("sets links to '[]' when none are filled in", () => {
    expect(buildSiteFormData(BASE).get("links")).toBe("[]");
  });
});
