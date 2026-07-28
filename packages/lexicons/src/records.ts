import { OPENCONTENT_COLLECTION, OPENCONTENT_PHOTOGRAPH, OPENCONTENT_SITE } from "./index.js";

// --- grapheme / byte length helpers -----------------------------------------
//
// Lexicon string limits come in two units: `maxGraphemes` (user-facing
// character count — a grapheme cluster can be many UTF-16 code units, e.g.
// an emoji with a ZWJ sequence) and `maxLength` (the wire limit, UTF-8 byte
// count). `graphemeLength` below is copied from
// `~/workspace/luminance.social/packages/atproto/src/interaction-records.ts`.

const segmenter = new Intl.Segmenter();

function graphemeLength(s: string): number {
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

const utf8Encoder = new TextEncoder();

function utf8Length(s: string): number {
  return utf8Encoder.encode(s).length;
}

function assertMaxGraphemes(label: string, value: string | undefined, max: number): void {
  if (value === undefined) return;
  const len = graphemeLength(value);
  if (len > max) throw new Error(`${label} must not exceed ${max} graphemes (got ${len})`);
}

function assertMaxBytes(label: string, value: string | undefined, max: number): void {
  if (value === undefined) return;
  const len = utf8Length(value);
  if (len > max) throw new Error(`${label} must not exceed ${max} UTF-8 bytes (got ${len})`);
}

// --- shared shapes -----------------------------------------------------------

/**
 * The wire shape of an ATProto blob reference, as it appears (de)serialized
 * in record JSON. Not the `@atproto/lexicon` `BlobRef` class instance (this
 * package doesn't depend on `@atproto/lexicon` at runtime, only in tests) —
 * just the plain `{ $type: "blob", ref, mimeType, size }` object.
 */
export interface BlobRef {
  $type: "blob";
  ref: unknown;
  mimeType: string;
  size: number;
}

export interface AspectRatio {
  width: number;
  height: number;
}

/**
 * Design note (spec §3): `fNumber` is a **string** in the lexicon — lexicons
 * have no float type; "2.8" round-trips exactly.
 */
export interface Exif {
  camera?: string;
  lens?: string;
  focalLength?: string;
  fNumber?: string;
  shutterSpeed?: string;
  iso?: number;
}

export interface StrongRef {
  uri: string;
  cid: string;
}

export interface SelfLabel {
  val: string;
}

export interface SelfLabels {
  $type: "com.atproto.label.defs#selfLabels";
  values: SelfLabel[];
}

export interface SiteLink {
  label: string;
  uri: string;
}

// --- social.opencontent.photograph -------------------------------------------

const PHOTOGRAPH_IMAGE_ACCEPT = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/heic"] as const;
const PHOTOGRAPH_IMAGE_MAX_SIZE = 20971520; // 20MB, advisory (host-PDS limit is the effective ceiling)
const TITLE_MAX_GRAPHEMES = 200;
const TITLE_MAX_BYTES = 800;
const DESCRIPTION_MAX_GRAPHEMES = 2000;
const DESCRIPTION_MAX_BYTES = 8000;
const ALT_MAX_GRAPHEMES = 2000;
const ALT_MAX_BYTES = 8000;
const TAGS_MAX_ITEMS = 20;
const TAG_MAX_GRAPHEMES = 64;
const TAG_MAX_BYTES = 256;
const LICENSE_MAX_GRAPHEMES = 200;
const LICENSE_MAX_BYTES = 800;
const LOCATION_MAX_GRAPHEMES = 200;
const LOCATION_MAX_BYTES = 800;
const EXIF_CAMERA_MAX_BYTES = 256;
const EXIF_LENS_MAX_BYTES = 256;
const EXIF_FOCAL_LENGTH_MAX_BYTES = 64;
const EXIF_FNUMBER_MAX_BYTES = 64;
const EXIF_SHUTTER_SPEED_MAX_BYTES = 64;

export interface PhotographInput {
  image: BlobRef;
  aspectRatio: AspectRatio;
  title?: string;
  description?: string;
  alt?: string;
  exif?: Exif;
  tags?: string[];
  license?: string;
  location?: string;
  capturedAt?: string;
  /** ISO datetime; defaults to now if omitted. */
  createdAt?: string;
  labels?: SelfLabels;
}

export type PhotographRecord = Omit<PhotographInput, "createdAt"> & {
  $type: typeof OPENCONTENT_PHOTOGRAPH;
  createdAt: string;
};

function assertAspectRatio(aspectRatio: AspectRatio | undefined): asserts aspectRatio is AspectRatio {
  if (!aspectRatio) throw new Error("photograph.aspectRatio is required");
  if (!Number.isInteger(aspectRatio.width) || aspectRatio.width < 1) {
    throw new Error("photograph.aspectRatio.width must be an integer >= 1");
  }
  if (!Number.isInteger(aspectRatio.height) || aspectRatio.height < 1) {
    throw new Error("photograph.aspectRatio.height must be an integer >= 1");
  }
}

function assertImage(image: BlobRef | undefined): asserts image is BlobRef {
  if (!image || typeof image !== "object") throw new Error("photograph.image is required");
  if (!PHOTOGRAPH_IMAGE_ACCEPT.includes(image.mimeType as (typeof PHOTOGRAPH_IMAGE_ACCEPT)[number])) {
    throw new Error(
      `photograph.image.mimeType "${image.mimeType}" is not accepted; must be one of ${PHOTOGRAPH_IMAGE_ACCEPT.join(", ")}`,
    );
  }
  if (typeof image.size !== "number" || image.size > PHOTOGRAPH_IMAGE_MAX_SIZE) {
    throw new Error(`photograph.image.size must not exceed ${PHOTOGRAPH_IMAGE_MAX_SIZE} bytes (20MB)`);
  }
}

function assertExif(exif: Exif | undefined): void {
  if (!exif) return;
  assertMaxBytes("photograph.exif.camera", exif.camera, EXIF_CAMERA_MAX_BYTES);
  assertMaxBytes("photograph.exif.lens", exif.lens, EXIF_LENS_MAX_BYTES);
  assertMaxBytes("photograph.exif.focalLength", exif.focalLength, EXIF_FOCAL_LENGTH_MAX_BYTES);
  assertMaxBytes("photograph.exif.fNumber", exif.fNumber, EXIF_FNUMBER_MAX_BYTES);
  assertMaxBytes("photograph.exif.shutterSpeed", exif.shutterSpeed, EXIF_SHUTTER_SPEED_MAX_BYTES);
  if (exif.iso !== undefined && (!Number.isInteger(exif.iso) || exif.iso < 0)) {
    throw new Error("photograph.exif.iso must be an integer >= 0");
  }
}

export function buildPhotograph(input: PhotographInput): PhotographRecord {
  assertImage(input.image);
  assertAspectRatio(input.aspectRatio);
  assertMaxGraphemes("photograph.title", input.title, TITLE_MAX_GRAPHEMES);
  assertMaxBytes("photograph.title", input.title, TITLE_MAX_BYTES);
  assertMaxGraphemes("photograph.description", input.description, DESCRIPTION_MAX_GRAPHEMES);
  assertMaxBytes("photograph.description", input.description, DESCRIPTION_MAX_BYTES);
  assertMaxGraphemes("photograph.alt", input.alt, ALT_MAX_GRAPHEMES);
  assertMaxBytes("photograph.alt", input.alt, ALT_MAX_BYTES);
  assertMaxGraphemes("photograph.license", input.license, LICENSE_MAX_GRAPHEMES);
  assertMaxBytes("photograph.license", input.license, LICENSE_MAX_BYTES);
  assertMaxGraphemes("photograph.location", input.location, LOCATION_MAX_GRAPHEMES);
  assertMaxBytes("photograph.location", input.location, LOCATION_MAX_BYTES);
  assertExif(input.exif);
  if (input.tags !== undefined) {
    if (input.tags.length > TAGS_MAX_ITEMS) {
      throw new Error(`photograph.tags must not have more than ${TAGS_MAX_ITEMS} items (got ${input.tags.length})`);
    }
    for (const tag of input.tags) {
      assertMaxGraphemes("photograph.tags[]", tag, TAG_MAX_GRAPHEMES);
      assertMaxBytes("photograph.tags[]", tag, TAG_MAX_BYTES);
    }
  }

  const record: PhotographRecord = {
    $type: OPENCONTENT_PHOTOGRAPH,
    image: input.image,
    aspectRatio: input.aspectRatio,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  if (input.title !== undefined) record.title = input.title;
  if (input.description !== undefined) record.description = input.description;
  if (input.alt !== undefined) record.alt = input.alt;
  if (input.exif !== undefined) record.exif = input.exif;
  if (input.tags !== undefined) record.tags = input.tags;
  if (input.license !== undefined) record.license = input.license;
  if (input.location !== undefined) record.location = input.location;
  if (input.capturedAt !== undefined) record.capturedAt = input.capturedAt;
  if (input.labels !== undefined) record.labels = input.labels;
  return record;
}

// --- social.opencontent.collection --------------------------------------------

const COLLECTION_ITEMS_MAX = 500;

export interface CollectionInput {
  title: string;
  description?: string;
  items: StrongRef[];
  cover?: StrongRef;
  /** ISO datetime; defaults to now if omitted. */
  createdAt?: string;
}

export type CollectionRecord = Omit<CollectionInput, "createdAt"> & {
  $type: typeof OPENCONTENT_COLLECTION;
  createdAt: string;
};

function assertStrongRef(label: string, ref: StrongRef | undefined): asserts ref is StrongRef {
  if (!ref || typeof ref.uri !== "string" || typeof ref.cid !== "string") {
    throw new Error(`${label} must be a strongRef ({ uri, cid })`);
  }
}

export function buildCollection(input: CollectionInput): CollectionRecord {
  if (typeof input.title !== "string") throw new Error("collection.title is required");
  assertMaxGraphemes("collection.title", input.title, TITLE_MAX_GRAPHEMES);
  assertMaxBytes("collection.title", input.title, TITLE_MAX_BYTES);
  assertMaxGraphemes("collection.description", input.description, DESCRIPTION_MAX_GRAPHEMES);
  assertMaxBytes("collection.description", input.description, DESCRIPTION_MAX_BYTES);
  if (!Array.isArray(input.items)) throw new Error("collection.items is required");
  if (input.items.length > COLLECTION_ITEMS_MAX) {
    throw new Error(`collection.items must not have more than ${COLLECTION_ITEMS_MAX} items (got ${input.items.length})`);
  }
  input.items.forEach((item, i) => assertStrongRef(`collection.items[${i}]`, item));
  if (input.cover !== undefined) assertStrongRef("collection.cover", input.cover);

  const record: CollectionRecord = {
    $type: OPENCONTENT_COLLECTION,
    title: input.title,
    items: input.items,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  if (input.description !== undefined) record.description = input.description;
  if (input.cover !== undefined) record.cover = input.cover;
  return record;
}

// --- social.opencontent.site ---------------------------------------------------

const ABOUT_MAX_GRAPHEMES = 5000;
const ABOUT_MAX_BYTES = 20000;
const COLLECTION_ORDER_MAX = 100;
const LINKS_MAX = 10;
const LINK_LABEL_MAX_GRAPHEMES = 50;
const LINK_LABEL_MAX_BYTES = 200;
const THEME_MAX_BYTES = 64;

export interface SiteInput {
  title: string;
  about?: string;
  collectionOrder?: string[];
  links?: SiteLink[];
  theme?: string;
  /** ISO datetime; defaults to now if omitted. */
  createdAt?: string;
}

export type SiteRecord = Omit<SiteInput, "createdAt"> & {
  $type: typeof OPENCONTENT_SITE;
  createdAt: string;
};

/**
 * Builds a `social.opencontent.site` record.
 *
 * The lexicon's `key: "literal:self"` (rkey `self`, one record per repo) is a
 * constraint on *how the record is written* — the rkey argument passed to
 * `com.atproto.repo.putRecord` — not a field carried inside the record body.
 * This builder therefore takes no rkey input and the returned record has no
 * rkey-shaped property; callers are responsible for using `rkey: "self"`.
 */
export function buildSite(input: SiteInput): SiteRecord {
  if (typeof input.title !== "string") throw new Error("site.title is required");
  assertMaxGraphemes("site.title", input.title, TITLE_MAX_GRAPHEMES);
  assertMaxBytes("site.title", input.title, TITLE_MAX_BYTES);
  assertMaxGraphemes("site.about", input.about, ABOUT_MAX_GRAPHEMES);
  assertMaxBytes("site.about", input.about, ABOUT_MAX_BYTES);
  if (input.collectionOrder !== undefined) {
    if (input.collectionOrder.length > COLLECTION_ORDER_MAX) {
      throw new Error(
        `site.collectionOrder must not have more than ${COLLECTION_ORDER_MAX} items (got ${input.collectionOrder.length})`,
      );
    }
    input.collectionOrder.forEach((rkey, i) => {
      if (typeof rkey !== "string" || rkey.length === 0) {
        throw new Error(`site.collectionOrder[${i}] must be a non-empty record-key string`);
      }
    });
  }
  if (input.links !== undefined) {
    if (input.links.length > LINKS_MAX) {
      throw new Error(`site.links must not have more than ${LINKS_MAX} items (got ${input.links.length})`);
    }
    input.links.forEach((link, i) => {
      if (typeof link.label !== "string") throw new Error(`site.links[${i}].label is required`);
      if (typeof link.uri !== "string") throw new Error(`site.links[${i}].uri is required`);
      assertMaxGraphemes(`site.links[${i}].label`, link.label, LINK_LABEL_MAX_GRAPHEMES);
      assertMaxBytes(`site.links[${i}].label`, link.label, LINK_LABEL_MAX_BYTES);
    });
  }
  assertMaxBytes("site.theme", input.theme, THEME_MAX_BYTES);

  const record: SiteRecord = {
    $type: OPENCONTENT_SITE,
    title: input.title,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  if (input.about !== undefined) record.about = input.about;
  if (input.collectionOrder !== undefined) record.collectionOrder = input.collectionOrder;
  if (input.links !== undefined) record.links = input.links;
  if (input.theme !== undefined) record.theme = input.theme;
  return record;
}
