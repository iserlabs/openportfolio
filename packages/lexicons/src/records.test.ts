import { describe, expect, it } from "vitest";
import { buildCollection, buildPhotograph, buildSite } from "./records.js";
import type { BlobRef } from "./records.js";

function validImage(overrides: Partial<BlobRef> = {}): BlobRef {
  return { $type: "blob", ref: { $link: "bafkreib3vqp" }, mimeType: "image/jpeg", size: 12345, ...overrides };
}

// A single grapheme cluster (Intl.Segmenter merges the regional-indicator
// pair into one flag) that is 8 UTF-8 bytes — 2x the 4-bytes-per-grapheme
// ratio the schema's maxGraphemes/maxLength pairs assume. Repeating it lets
// a fixture sit exactly at a maxGraphemes limit while blowing well past the
// corresponding maxLength (byte) limit, proving the two checks are
// independent rather than the byte check being incidentally implied by the
// grapheme check.
const DENSE_GRAPHEME = "\u{1F1FA}\u{1F1F8}"; // 🇺🇸, 1 grapheme, 8 UTF-8 bytes

describe("buildPhotograph", () => {
  it("builds a record from the minimal required fields, filling $type and defaulting createdAt to now", () => {
    const before = Date.now();
    const record = buildPhotograph({ image: validImage(), aspectRatio: { width: 4, height: 3 } });
    const after = Date.now();

    expect(record.$type).toBe("social.opencontent.photograph");
    expect(record.image).toEqual(validImage());
    expect(record.aspectRatio).toEqual({ width: 4, height: 3 });
    expect(new Date(record.createdAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(record.createdAt).getTime()).toBeLessThanOrEqual(after);
  });

  it("preserves a caller-supplied createdAt instead of defaulting", () => {
    const record = buildPhotograph({
      image: validImage(),
      aspectRatio: { width: 4, height: 3 },
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    expect(record.createdAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("builds a record with every optional field populated", () => {
    const record = buildPhotograph({
      image: validImage(),
      aspectRatio: { width: 4, height: 3 },
      title: "Low tide, Sandy Hook",
      description: "A caption.",
      alt: "A gull standing on wet sand.",
      exif: { camera: "Nikon Z8", lens: "Z 100-400mm", focalLength: "400mm", fNumber: "2.8", shutterSpeed: "1/2000", iso: 640 },
      tags: ["birds", "shorebirds"],
      license: "CC BY 4.0",
      location: "Sandy Hook, NJ",
      capturedAt: "2026-07-20T12:00:00.000Z",
      labels: { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "nudity" }] },
    });
    expect(record.title).toBe("Low tide, Sandy Hook");
    expect(record.tags).toEqual(["birds", "shorebirds"]);
    expect(record.exif?.iso).toBe(640);
  });

  // Design note (spec §3): fNumber is a string in the lexicon — lexicons have
  // no float type; "2.8" round-trips exactly.
  it("round-trips exif.fNumber as the exact string supplied, e.g. \"2.8\"", () => {
    const record = buildPhotograph({
      image: validImage(),
      aspectRatio: { width: 4, height: 3 },
      exif: { fNumber: "2.8" },
    });
    expect(record.exif?.fNumber).toBe("2.8");
    expect(typeof record.exif?.fNumber).toBe("string");
  });

  it("throws when image is missing", () => {
    // @ts-expect-error — testing the runtime guard for a missing required field
    expect(() => buildPhotograph({ aspectRatio: { width: 4, height: 3 } })).toThrow(/image/i);
  });

  it("throws when image.mimeType is not in the raster allowlist (e.g. SVG)", () => {
    expect(() =>
      buildPhotograph({ image: validImage({ mimeType: "image/svg+xml" }), aspectRatio: { width: 4, height: 3 } }),
    ).toThrow(/mimeType/i);
  });

  it("throws when image.size exceeds the 20MB maxSize", () => {
    expect(() =>
      buildPhotograph({ image: validImage({ size: 20971521 }), aspectRatio: { width: 4, height: 3 } }),
    ).toThrow(/size/i);
  });

  it("accepts image.size exactly at the 20MB maxSize boundary", () => {
    expect(() =>
      buildPhotograph({ image: validImage({ size: 20971520 }), aspectRatio: { width: 4, height: 3 } }),
    ).not.toThrow();
  });

  it("throws when aspectRatio is missing", () => {
    // @ts-expect-error — testing the runtime guard for a missing required field
    expect(() => buildPhotograph({ image: validImage() })).toThrow(/aspectRatio/i);
  });

  it("throws when aspectRatio.width is below the minimum of 1", () => {
    expect(() => buildPhotograph({ image: validImage(), aspectRatio: { width: 0, height: 3 } })).toThrow(/width/i);
  });

  it("throws when aspectRatio.height is below the minimum of 1", () => {
    expect(() => buildPhotograph({ image: validImage(), aspectRatio: { width: 4, height: 0 } })).toThrow(/height/i);
  });

  it("throws when title exceeds 200 graphemes", () => {
    expect(() =>
      buildPhotograph({ image: validImage(), aspectRatio: { width: 4, height: 3 }, title: "a".repeat(201) }),
    ).toThrow(/title/i);
  });

  it("accepts a title of exactly 200 graphemes", () => {
    expect(() =>
      buildPhotograph({ image: validImage(), aspectRatio: { width: 4, height: 3 }, title: "a".repeat(200) }),
    ).not.toThrow();
  });

  it("throws when title is within 200 graphemes but exceeds 800 UTF-8 bytes", () => {
    expect(() =>
      buildPhotograph({
        image: validImage(),
        aspectRatio: { width: 4, height: 3 },
        title: DENSE_GRAPHEME.repeat(200),
      }),
    ).toThrow(/title/i);
  });

  it("throws when description exceeds 2000 graphemes", () => {
    expect(() =>
      buildPhotograph({ image: validImage(), aspectRatio: { width: 4, height: 3 }, description: "a".repeat(2001) }),
    ).toThrow(/description/i);
  });

  it("throws when description is within 2000 graphemes but exceeds 8000 UTF-8 bytes", () => {
    expect(() =>
      buildPhotograph({
        image: validImage(),
        aspectRatio: { width: 4, height: 3 },
        description: DENSE_GRAPHEME.repeat(2000),
      }),
    ).toThrow(/description/i);
  });

  it("throws when alt exceeds 2000 graphemes", () => {
    expect(() =>
      buildPhotograph({ image: validImage(), aspectRatio: { width: 4, height: 3 }, alt: "a".repeat(2001) }),
    ).toThrow(/alt/i);
  });

  it("throws when alt is within 2000 graphemes but exceeds 8000 UTF-8 bytes", () => {
    expect(() =>
      buildPhotograph({ image: validImage(), aspectRatio: { width: 4, height: 3 }, alt: DENSE_GRAPHEME.repeat(2000) }),
    ).toThrow(/alt/i);
  });

  it("throws when license exceeds 200 graphemes", () => {
    expect(() =>
      buildPhotograph({ image: validImage(), aspectRatio: { width: 4, height: 3 }, license: "a".repeat(201) }),
    ).toThrow(/license/i);
  });

  it("throws when license is within 200 graphemes but exceeds 800 UTF-8 bytes", () => {
    expect(() =>
      buildPhotograph({
        image: validImage(),
        aspectRatio: { width: 4, height: 3 },
        license: DENSE_GRAPHEME.repeat(200),
      }),
    ).toThrow(/license/i);
  });

  it("throws when location exceeds 200 graphemes", () => {
    expect(() =>
      buildPhotograph({ image: validImage(), aspectRatio: { width: 4, height: 3 }, location: "a".repeat(201) }),
    ).toThrow(/location/i);
  });

  it("throws when location is within 200 graphemes but exceeds 800 UTF-8 bytes", () => {
    expect(() =>
      buildPhotograph({
        image: validImage(),
        aspectRatio: { width: 4, height: 3 },
        location: DENSE_GRAPHEME.repeat(200),
      }),
    ).toThrow(/location/i);
  });

  it("throws when tags has more than 20 items", () => {
    expect(() =>
      buildPhotograph({
        image: validImage(),
        aspectRatio: { width: 4, height: 3 },
        tags: Array.from({ length: 21 }, (_, i) => `tag${i}`),
      }),
    ).toThrow(/tags/i);
  });

  it("accepts exactly 20 tags", () => {
    expect(() =>
      buildPhotograph({
        image: validImage(),
        aspectRatio: { width: 4, height: 3 },
        tags: Array.from({ length: 20 }, (_, i) => `tag${i}`),
      }),
    ).not.toThrow();
  });

  it("throws when a tag exceeds 64 graphemes", () => {
    expect(() =>
      buildPhotograph({ image: validImage(), aspectRatio: { width: 4, height: 3 }, tags: ["a".repeat(65)] }),
    ).toThrow(/tag/i);
  });

  it("throws when a tag is within 64 graphemes but exceeds 256 UTF-8 bytes", () => {
    expect(() =>
      buildPhotograph({
        image: validImage(),
        aspectRatio: { width: 4, height: 3 },
        tags: [DENSE_GRAPHEME.repeat(64)],
      }),
    ).toThrow(/tag/i);
  });

  it("throws when exif.camera exceeds 256 bytes", () => {
    expect(() =>
      buildPhotograph({
        image: validImage(),
        aspectRatio: { width: 4, height: 3 },
        exif: { camera: "a".repeat(257) },
      }),
    ).toThrow(/camera/i);
  });

  it("throws when exif.lens exceeds 256 bytes", () => {
    expect(() =>
      buildPhotograph({ image: validImage(), aspectRatio: { width: 4, height: 3 }, exif: { lens: "a".repeat(257) } }),
    ).toThrow(/lens/i);
  });

  it("throws when exif.focalLength exceeds 64 bytes", () => {
    expect(() =>
      buildPhotograph({
        image: validImage(),
        aspectRatio: { width: 4, height: 3 },
        exif: { focalLength: "a".repeat(65) },
      }),
    ).toThrow(/focalLength/i);
  });

  it("throws when exif.fNumber exceeds 64 bytes", () => {
    expect(() =>
      buildPhotograph({ image: validImage(), aspectRatio: { width: 4, height: 3 }, exif: { fNumber: "a".repeat(65) } }),
    ).toThrow(/fNumber/i);
  });

  it("throws when exif.shutterSpeed exceeds 64 bytes", () => {
    expect(() =>
      buildPhotograph({
        image: validImage(),
        aspectRatio: { width: 4, height: 3 },
        exif: { shutterSpeed: "a".repeat(65) },
      }),
    ).toThrow(/shutterSpeed/i);
  });

  it("throws when exif.iso is negative", () => {
    expect(() =>
      buildPhotograph({ image: validImage(), aspectRatio: { width: 4, height: 3 }, exif: { iso: -1 } }),
    ).toThrow(/iso/i);
  });

  it("throws when exif.iso is not an integer", () => {
    expect(() =>
      buildPhotograph({ image: validImage(), aspectRatio: { width: 4, height: 3 }, exif: { iso: 1.5 } }),
    ).toThrow(/iso/i);
  });
});

describe("buildCollection", () => {
  function ref(n: number) {
    return { uri: `at://did:plc:abc/social.opencontent.photograph/${n}`, cid: "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a" };
  }

  it("builds a record from the minimal required fields, filling $type and defaulting createdAt to now", () => {
    const before = Date.now();
    const record = buildCollection({ title: "Shorebirds 2026", items: [ref(1), ref(2)] });
    const after = Date.now();

    expect(record.$type).toBe("social.opencontent.collection");
    expect(record.title).toBe("Shorebirds 2026");
    expect(record.items).toEqual([ref(1), ref(2)]);
    expect(new Date(record.createdAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(record.createdAt).getTime()).toBeLessThanOrEqual(after);
  });

  it("builds a record with description and cover populated", () => {
    const record = buildCollection({
      title: "Shorebirds 2026",
      description: "A season of shorebird work.",
      items: [ref(1)],
      cover: ref(1),
    });
    expect(record.description).toBe("A season of shorebird work.");
    expect(record.cover).toEqual(ref(1));
  });

  it("throws when title is missing", () => {
    // @ts-expect-error — testing the runtime guard for a missing required field
    expect(() => buildCollection({ items: [ref(1)] })).toThrow(/title/i);
  });

  it("throws when title exceeds 200 graphemes", () => {
    expect(() => buildCollection({ title: "a".repeat(201), items: [ref(1)] })).toThrow(/title/i);
  });

  it("throws when title is within 200 graphemes but exceeds 800 UTF-8 bytes", () => {
    expect(() => buildCollection({ title: DENSE_GRAPHEME.repeat(200), items: [ref(1)] })).toThrow(/title/i);
  });

  it("throws when items is missing", () => {
    // @ts-expect-error — testing the runtime guard for a missing required field
    expect(() => buildCollection({ title: "T" })).toThrow(/items/i);
  });

  it("throws when items has more than 500 entries", () => {
    const items = Array.from({ length: 501 }, (_, i) => ref(i));
    expect(() => buildCollection({ title: "T", items })).toThrow(/items/i);
  });

  it("accepts exactly 500 items", () => {
    const items = Array.from({ length: 500 }, (_, i) => ref(i));
    expect(() => buildCollection({ title: "T", items })).not.toThrow();
  });

  it("throws when description exceeds 2000 graphemes", () => {
    expect(() => buildCollection({ title: "T", items: [ref(1)], description: "a".repeat(2001) })).toThrow(
      /description/i,
    );
  });

  it("throws when description is within 2000 graphemes but exceeds 8000 UTF-8 bytes", () => {
    expect(() =>
      buildCollection({ title: "T", items: [ref(1)], description: DENSE_GRAPHEME.repeat(2000) }),
    ).toThrow(/description/i);
  });
});

describe("buildSite", () => {
  it("builds a record from the minimal required fields, filling $type and defaulting createdAt to now", () => {
    const before = Date.now();
    const record = buildSite({ title: "Kevin Lee Photography" });
    const after = Date.now();

    expect(record.$type).toBe("social.opencontent.site");
    expect(record.title).toBe("Kevin Lee Photography");
    expect(new Date(record.createdAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(record.createdAt).getTime()).toBeLessThanOrEqual(after);
  });

  it("builds a record with about, collectionOrder, links, and theme populated", () => {
    const record = buildSite({
      title: "Kevin Lee Photography",
      about: "Bird and landscape photography.",
      collectionOrder: ["3jxyzabc123", "3jxyzabc456"],
      links: [{ label: "Instagram", uri: "https://instagram.com/example" }],
      theme: "dark",
    });
    expect(record.collectionOrder).toEqual(["3jxyzabc123", "3jxyzabc456"]);
    expect(record.links).toEqual([{ label: "Instagram", uri: "https://instagram.com/example" }]);
    expect(record.theme).toBe("dark");
  });

  // The lexicon's `key: "literal:self"` (rkey "self", one record per repo) is
  // a constraint on how the record is written (com.atproto.repo.putRecord's
  // rkey parameter), not a field inside the record body — so buildSite takes
  // no rkey input and the output carries no rkey-shaped property. Callers are
  // responsible for using rkey: "self" when writing this record.
  it("documents the rkey:self convention by never emitting an rkey field itself", () => {
    const record = buildSite({ title: "T" });
    expect(record).not.toHaveProperty("rkey");
  });

  it("throws when title is missing", () => {
    // @ts-expect-error — testing the runtime guard for a missing required field
    expect(() => buildSite({})).toThrow(/title/i);
  });

  it("throws when title exceeds 200 graphemes", () => {
    expect(() => buildSite({ title: "a".repeat(201) })).toThrow(/title/i);
  });

  it("throws when title is within 200 graphemes but exceeds 800 UTF-8 bytes", () => {
    expect(() => buildSite({ title: DENSE_GRAPHEME.repeat(200) })).toThrow(/title/i);
  });

  it("throws when about exceeds 5000 graphemes", () => {
    expect(() => buildSite({ title: "T", about: "a".repeat(5001) })).toThrow(/about/i);
  });

  it("accepts about of exactly 5000 graphemes", () => {
    expect(() => buildSite({ title: "T", about: "a".repeat(5000) })).not.toThrow();
  });

  it("throws when about is within 5000 graphemes but exceeds 20000 UTF-8 bytes", () => {
    expect(() => buildSite({ title: "T", about: DENSE_GRAPHEME.repeat(5000) })).toThrow(/about/i);
  });

  it("throws when collectionOrder has more than 100 entries", () => {
    const collectionOrder = Array.from({ length: 101 }, (_, i) => `3jxyz${i}`);
    expect(() => buildSite({ title: "T", collectionOrder })).toThrow(/collectionOrder/i);
  });

  it("accepts exactly 100 collectionOrder entries", () => {
    const collectionOrder = Array.from({ length: 100 }, (_, i) => `3jxyz${i}`);
    expect(() => buildSite({ title: "T", collectionOrder })).not.toThrow();
  });

  it("throws when links has more than 10 entries", () => {
    const links = Array.from({ length: 11 }, (_, i) => ({ label: `L${i}`, uri: `https://example.com/${i}` }));
    expect(() => buildSite({ title: "T", links })).toThrow(/links/i);
  });

  it("accepts exactly 10 links", () => {
    const links = Array.from({ length: 10 }, (_, i) => ({ label: `L${i}`, uri: `https://example.com/${i}` }));
    expect(() => buildSite({ title: "T", links })).not.toThrow();
  });

  it("throws when a link is missing its required uri", () => {
    // @ts-expect-error — testing the runtime guard for a missing required field
    expect(() => buildSite({ title: "T", links: [{ label: "Instagram" }] })).toThrow(/uri/i);
  });

  it("throws when a link is missing its required label", () => {
    // @ts-expect-error — testing the runtime guard for a missing required field
    expect(() => buildSite({ title: "T", links: [{ uri: "https://example.com" }] })).toThrow(/label/i);
  });

  it("throws when a link label exceeds 50 graphemes", () => {
    expect(() => buildSite({ title: "T", links: [{ label: "a".repeat(51), uri: "https://example.com" }] })).toThrow(
      /label/i,
    );
  });

  it("throws when a link label is within 50 graphemes but exceeds 200 UTF-8 bytes", () => {
    expect(() =>
      buildSite({ title: "T", links: [{ label: DENSE_GRAPHEME.repeat(50), uri: "https://example.com" }] }),
    ).toThrow(/label/i);
  });

  it("throws when theme exceeds 64 bytes", () => {
    expect(() => buildSite({ title: "T", theme: "a".repeat(65) })).toThrow(/theme/i);
  });

  it("accepts theme of exactly 64 bytes", () => {
    expect(() => buildSite({ title: "T", theme: "a".repeat(64) })).not.toThrow();
  });
});
