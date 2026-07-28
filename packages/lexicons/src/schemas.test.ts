import { BlobRef, Lexicons, type LexiconDoc } from "@atproto/lexicon";
import { describe, expect, it } from "vitest";
import photograph from "../lexicons/social/opencontent/photograph.json" with { type: "json" };
import collection from "../lexicons/social/opencontent/collection.json" with { type: "json" };
import site from "../lexicons/social/opencontent/site.json" with { type: "json" };
import strongRef from "../lexicons/com/atproto/repo/strongRef.json" with { type: "json" };
import labelDefs from "../lexicons/com/atproto/label/defs.json" with { type: "json" };

// `@atproto/lexicon`'s Lexicons needs every referenced schema doc loaded
// locally to resolve `#ref`s and cross-NSID refs (com.atproto.repo.strongRef,
// com.atproto.label.defs#selfLabels) — hence the local copies in
// lexicons/com/atproto/.
const lex = new Lexicons([photograph, collection, site, strongRef, labelDefs] as LexiconDoc[]);

function validImage() {
  // `BlobRef`'s constructor types `ref` as a real `CID` instance, but its
  // validator only checks `instanceof BlobRef` (see the "rejects a blob that
  // is not a BlobRef instance" test below) — the exact `ref` shape isn't
  // load-bearing here, so a raw `{ $link }` JSON ref is cast through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new BlobRef({ $link: "bafkreib3vqp" } as any, "image/jpeg", 12345);
}

describe("social.opencontent.photograph schema", () => {
  it("validates a well-formed record", () => {
    expect(() =>
      lex.assertValidRecord("social.opencontent.photograph", {
        $type: "social.opencontent.photograph",
        image: validImage(),
        aspectRatio: { width: 4, height: 3 },
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("validates a record carrying optional fields, exif, tags, and labels", () => {
    expect(() =>
      lex.assertValidRecord("social.opencontent.photograph", {
        $type: "social.opencontent.photograph",
        image: validImage(),
        aspectRatio: { width: 4, height: 3 },
        title: "Low tide, Sandy Hook",
        description: "A caption.",
        alt: "A gull standing on wet sand at low tide.",
        exif: { camera: "Nikon Z8", lens: "Z 100-400mm", focalLength: "400mm", fNumber: "2.8", shutterSpeed: "1/2000", iso: 640 },
        tags: ["birds", "shorebirds"],
        license: "CC BY 4.0",
        location: "Sandy Hook, NJ",
        capturedAt: "2026-07-20T12:00:00.000Z",
        createdAt: "2026-07-21T00:00:00.000Z",
        labels: { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "nudity" }] },
      }),
    ).not.toThrow();
  });

  it("rejects a record missing the required aspectRatio field", () => {
    expect(() =>
      lex.assertValidRecord("social.opencontent.photograph", {
        $type: "social.opencontent.photograph",
        image: validImage(),
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects a record missing the required image field", () => {
    expect(() =>
      lex.assertValidRecord("social.opencontent.photograph", {
        $type: "social.opencontent.photograph",
        aspectRatio: { width: 4, height: 3 },
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects aspectRatio.width below the minimum of 1", () => {
    expect(() =>
      lex.assertValidRecord("social.opencontent.photograph", {
        $type: "social.opencontent.photograph",
        image: validImage(),
        aspectRatio: { width: 0, height: 3 },
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects a title over 200 graphemes", () => {
    expect(() =>
      lex.assertValidRecord("social.opencontent.photograph", {
        $type: "social.opencontent.photograph",
        image: validImage(),
        aspectRatio: { width: 4, height: 3 },
        title: "a".repeat(201),
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects a title within 200 graphemes but over 800 UTF-8 bytes (maxLength and maxGraphemes are independent checks)", () => {
    // A flag emoji is 1 grapheme cluster (Intl.Segmenter merges the two
    // regional-indicator code points) but 8 UTF-8 bytes — repeating it 200
    // times stays within maxGraphemes while blowing past maxLength (800).
    const denseGrapheme = "\u{1F1FA}\u{1F1F8}"; // 🇺🇸
    expect(() =>
      lex.assertValidRecord("social.opencontent.photograph", {
        $type: "social.opencontent.photograph",
        image: validImage(),
        aspectRatio: { width: 4, height: 3 },
        title: denseGrapheme.repeat(200),
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects a blob that is not a BlobRef instance (e.g. a plain JSON object)", () => {
    // `@atproto/lexicon`'s local record validator only checks
    // `value instanceof BlobRef` for blob-typed fields — it does NOT check
    // the schema's `accept`/`maxSize` against the ref (that enforcement is
    // the host PDS's blob-upload endpoint's job, using this same metadata).
    // So a raw plain object never satisfies the blob field regardless of its
    // mimeType, and an SVG-mime rejection specifically is instead asserted
    // at the schema-shape level below and behaviorally in records.test.ts's
    // `buildPhotograph` mime-allowlist tests.
    expect(() =>
      lex.assertValidRecord("social.opencontent.photograph", {
        $type: "social.opencontent.photograph",
        image: { $type: "blob", ref: { $link: "bafkreib3vqp" }, mimeType: "image/jpeg", size: 123 },
        aspectRatio: { width: 4, height: 3 },
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("declares an explicit raster mime allowlist with no SVG and the 20MB advisory maxSize", () => {
    const image = photograph.defs.main.record.properties.image as {
      accept: string[];
      maxSize: number;
    };
    expect(image.accept).toEqual(["image/jpeg", "image/png", "image/webp", "image/avif", "image/heic"]);
    expect(image.accept).not.toContain("image/svg+xml");
    expect(image.maxSize).toBe(20971520);
  });
});

describe("social.opencontent.collection schema", () => {
  function strongRefFixture(n: number) {
    return { uri: `at://did:plc:abc/social.opencontent.photograph/${n}`, cid: "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a" };
  }

  it("validates a well-formed record", () => {
    expect(() =>
      lex.assertValidRecord("social.opencontent.collection", {
        $type: "social.opencontent.collection",
        title: "Shorebirds 2026",
        items: [strongRefFixture(1), strongRefFixture(2)],
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("rejects a record missing the required title field", () => {
    expect(() =>
      lex.assertValidRecord("social.opencontent.collection", {
        $type: "social.opencontent.collection",
        items: [strongRefFixture(1)],
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects an items array of 501 strongRefs (over the 500 maxLength)", () => {
    const items = Array.from({ length: 501 }, (_, i) => strongRefFixture(i));
    expect(() =>
      lex.assertValidRecord("social.opencontent.collection", {
        $type: "social.opencontent.collection",
        title: "Too many",
        items,
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("accepts exactly 500 items (boundary, not over the limit)", () => {
    const items = Array.from({ length: 500 }, (_, i) => strongRefFixture(i));
    expect(() =>
      lex.assertValidRecord("social.opencontent.collection", {
        $type: "social.opencontent.collection",
        title: "Exactly 500",
        items,
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).not.toThrow();
  });
});

describe("social.opencontent.site schema", () => {
  it("validates a well-formed record", () => {
    expect(() =>
      lex.assertValidRecord("social.opencontent.site", {
        $type: "social.opencontent.site",
        title: "Kevin Lee Photography",
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("validates a record with links, collectionOrder, about, and theme", () => {
    expect(() =>
      lex.assertValidRecord("social.opencontent.site", {
        $type: "social.opencontent.site",
        title: "Kevin Lee Photography",
        about: "Bird and landscape photography.",
        collectionOrder: ["3jxyzabc123", "3jxyzabc456"],
        links: [{ label: "Instagram", uri: "https://instagram.com/example" }],
        theme: "dark",
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("rejects a record missing the required title field", () => {
    expect(() =>
      lex.assertValidRecord("social.opencontent.site", {
        $type: "social.opencontent.site",
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects a collectionOrder array of 101 rkeys (over the 100 maxLength)", () => {
    const collectionOrder = Array.from({ length: 101 }, (_, i) => `3jxyz${i}`);
    expect(() =>
      lex.assertValidRecord("social.opencontent.site", {
        $type: "social.opencontent.site",
        title: "T",
        collectionOrder,
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects a links array of 11 entries (over the 10 maxLength)", () => {
    const links = Array.from({ length: 11 }, (_, i) => ({ label: `L${i}`, uri: `https://example.com/${i}` }));
    expect(() =>
      lex.assertValidRecord("social.opencontent.site", {
        $type: "social.opencontent.site",
        title: "T",
        links,
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects a link missing the required uri field", () => {
    expect(() =>
      lex.assertValidRecord("social.opencontent.site", {
        $type: "social.opencontent.site",
        title: "T",
        links: [{ label: "Instagram" }],
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it(
    // The `self` rkey convention is not part of the record body at all — it's
    // the rkey the caller passes to com.atproto.repo.putRecord — so it is
    // asserted by nothing at the schema-validation layer; see records.test.ts
    // for the builder-level documentation of this convention.
    "has no rkey-shaped field in its own record properties (rkey:self is a builder/caller convention, not a schema field)",
    () => {
      expect(Object.keys(site.defs.main.record.properties)).not.toContain("rkey");
    },
  );
});
