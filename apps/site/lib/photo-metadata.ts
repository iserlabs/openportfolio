import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Exif } from "@open-portfolio/lexicons";
import { exiftool } from "exiftool-vendored";
import exifr from "exifr";
import sharp from "sharp";

/**
 * Prefill data the upload CMS form is seeded with from a photographer's
 * Lightroom-embedded IPTC/EXIF metadata. `exif` matches
 * `@open-portfolio/lexicons`' `PhotographInput.exif` shape exactly — same
 * field names, same types (`fNumber` a string, `iso` an integer) — so a
 * caller can pass it straight through to `buildPhotograph` without
 * reshaping.
 */
export interface Prefill {
  title?: string;
  description?: string;
  alt?: string;
  tags: string[];
  capturedAt?: string;
  exif: Exif;
  width: number;
  height: number;
  hasGps: boolean;
}

// --- container detection ------------------------------------------------
//
// Pure byte-signature sniffing — no decode step, so it works even for
// containers sharp's bundled libvips can't open (this build's HEIF decoder
// only lists ".avif" as a supported input suffix; plain HEIC is excluded,
// presumably for HEVC licensing reasons). stripGps needs to know the
// container to (a) pick the right extension for the temp file exiftool
// writes to, and (b) refuse AVIF outright rather than risk exiftool's
// unreliable AVIF write path leaving GPS in place.

type Container = "jpeg" | "png" | "webp" | "heic" | "avif" | "unknown";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

function detectContainer(buf: Buffer): Container {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "webp";
  }
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") {
    // ISOBMFF (HEIC/AVIF): a `ftyp` box declares a major brand at bytes
    // 8-12, then a list of 4-byte compatible brands filling out the rest of
    // the box (whose size is the buffer's first big-endian uint32).
    const boxSize = buf.readUInt32BE(0);
    const brands = new Set<string>([buf.toString("ascii", 8, 12)]);
    const end = Math.min(boxSize, buf.length);
    for (let offset = 16; offset + 4 <= end; offset += 4) {
      brands.add(buf.toString("ascii", offset, offset + 4));
    }
    for (const brand of brands) if (AVIF_BRANDS.has(brand)) return "avif";
    for (const brand of brands) if (HEIC_BRANDS.has(brand)) return "heic";
  }
  return "unknown";
}

const STRIP_EXTENSION: Record<"jpeg" | "png" | "webp" | "heic", string> = {
  jpeg: ".jpg",
  png: ".png",
  webp: ".webp",
  heic: ".heic",
};

// --- extractPrefill normalization helpers --------------------------------

/** exifr represents XMP lang-alt values (title/description) as `{ lang, value }`; plain tags as strings. */
function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (value && typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    const inner = (value as { value: unknown }).value;
    return typeof inner === "string" && inner.length > 0 ? inner : undefined;
  }
  return undefined;
}

function formatFNumber(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  // Lexicons have no float type; "2.8" round-trips exactly via String().
  return String(value);
}

function formatFocalLength(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return `${value}mm`;
}

/**
 * exifr reports ExposureTime as decimal seconds (e.g. 0.004 for 1/250s).
 * Photographers read shutter speed as a fraction below one second, and as
 * plain seconds at or above it — so we reformat rather than pass the raw
 * decimal through.
 */
function formatShutterSpeed(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  if (value < 1) return `1/${Math.round(1 / value)}`;
  return String(Number(value.toFixed(2)));
}

function combineCamera(make: unknown, model: unknown): string | undefined {
  const m = typeof make === "string" ? make.trim() : "";
  const mo = typeof model === "string" ? model.trim() : "";
  if (!m && !mo) return undefined;
  if (!m) return mo || undefined;
  if (!mo) return m;
  // Avoid "SONY SONY ILCE-7RM4"-style duplication when Model already embeds Make.
  return mo.toLowerCase().startsWith(m.toLowerCase()) ? mo : `${m} ${mo}`;
}

function toIsoDate(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

/**
 * Parses embedded IPTC/EXIF/XMP metadata plus image dimensions into the
 * shape the upload CMS form prefills from.
 *
 * Note: `exifr` has no RIFF/WebP parser (confirmed empirically — it throws
 * "Unknown file format" on WebP input), so metadata fields degrade to
 * "absent" for WebP uploads rather than throwing; width/height still come
 * from sharp, which decodes WebP fine. This only affects prefill quality,
 * never GPS-strip safety — `stripGps` does not depend on exifr for its
 * decision to strip.
 */
export async function extractPrefill(buf: Buffer): Promise<Prefill> {
  const [metadata, parsed] = await Promise.all([
    sharp(buf).metadata(),
    exifr.parse(buf, { iptc: true, tiff: true, exif: true, gps: true, xmp: true }).catch(() => undefined),
  ]);

  if (typeof metadata.width !== "number" || typeof metadata.height !== "number") {
    throw new Error("could not determine image dimensions");
  }

  const data = (parsed ?? {}) as Record<string, unknown>;

  const title = firstString(data.title);
  const description = firstString(data.description) ?? firstString(data.ImageDescription);
  const tags = Array.isArray(data.subject) ? data.subject.filter((t): t is string => typeof t === "string") : [];

  const exif: Exif = {};
  const camera = combineCamera(data.Make, data.Model);
  if (camera) exif.camera = camera;
  const lens = firstString(data.LensModel);
  if (lens) exif.lens = lens;
  const focalLength = formatFocalLength(data.FocalLength);
  if (focalLength) exif.focalLength = focalLength;
  const fNumber = formatFNumber(data.FNumber);
  if (fNumber) exif.fNumber = fNumber;
  const shutterSpeed = formatShutterSpeed(data.ExposureTime);
  if (shutterSpeed) exif.shutterSpeed = shutterSpeed;
  if (typeof data.ISO === "number" && Number.isFinite(data.ISO)) exif.iso = Math.round(data.ISO);

  const capturedAt = toIsoDate(data.DateTimeOriginal);
  const hasGps = typeof data.latitude === "number" && typeof data.longitude === "number";

  const prefill: Prefill = { tags, exif, width: metadata.width, height: metadata.height, hasGps };
  if (title) prefill.title = title;
  if (description) prefill.description = description;
  if (capturedAt) prefill.capturedAt = capturedAt;
  return prefill;
}

/**
 * Strips GPS metadata from an image blob. Metadata-only surgery: masters
 * are never recompressed, and decoded pixel data is byte-identical before
 * and after (verified in tests via `sharp(...).raw()` comparison).
 *
 * Supported containers: JPEG, PNG, WebP, HEIC. AVIF and anything
 * unrecognized throw instead of silently passing GPS through — exiftool's
 * AVIF write path is unreliable, and an unrecognized container gives us no
 * confidence a strip actually happened.
 *
 * Runs the deletion unconditionally rather than pre-checking for GPS
 * presence: `-gps:all=` against a file with no GPS tags is a verified no-op
 * (ExifTool reports "unchanged", not an error) and returns the input bytes
 * completely untouched — so this is also the code path for the "no GPS to
 * strip" case, with no separate short-circuit needed.
 */
export async function stripGps(buf: Buffer): Promise<Buffer> {
  const container = detectContainer(buf);
  if (container === "avif") {
    throw new Error("gps strip unsupported for avif; re-export without location");
  }
  if (container === "unknown") {
    throw new Error("gps strip unsupported for this image container; re-export without location");
  }

  const dir = await mkdtemp(path.join(tmpdir(), "photo-metadata-"));
  const file = path.join(dir, `image${STRIP_EXTENSION[container]}`);
  try {
    await writeFile(file, buf);
    await exiftool.write(file, {}, { writeArgs: ["-gps:all=", "-overwrite_original"] });
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
