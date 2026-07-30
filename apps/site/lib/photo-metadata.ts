import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Exif } from "@openportfolio/lexicons";
import { exiftool, type Tags } from "exiftool-vendored";
import exifr from "exifr";
import sharp from "sharp";

/**
 * Prefill data the upload CMS form is seeded with from a photographer's
 * Lightroom-embedded IPTC/EXIF metadata. `exif` matches
 * `@openportfolio/lexicons`' `PhotographInput.exif` shape exactly — same
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
// presumably for HEVC licensing reasons). We need to know the container to
// (a) pick the right extension for temp files handed to exiftool, (b)
// refuse AVIF outright in stripGps rather than risk exiftool's unreliable
// AVIF write path leaving GPS in place, and (c) recognize a HEIC buffer
// specifically so extractPrefill can turn a raw decode crash into an
// actionable message instead of a bare libvips error.

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

/** Extension to give a temp file per detected container, so exiftool's own format detection (which cares about extension on write) lines up. */
const CONTAINER_EXTENSION: Record<Container, string> = {
  jpeg: ".jpg",
  png: ".png",
  webp: ".webp",
  heic: ".heic",
  avif: ".avif",
  unknown: ".bin",
};

async function withTempFile<T>(buf: Buffer, ext: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "photo-metadata-"));
  const file = path.join(dir, `image${ext}`);
  try {
    await writeFile(file, buf);
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Reads tags via the actual `exiftool` binary rather than `exifr`. Used for
 * two things `exifr` cannot reliably provide across every accepted
 * container: (1) `hasGps` — exifr has no WebP (RIFF) parser at all, so an
 * exifr-only GPS check is a silent false negative for GPS-tagged WebP
 * uploads; exiftool reads GPS from every container we accept. (2) a
 * fallback source for title/description/tags when exifr returns nothing
 * (again, WebP) — exiftool's `Title`/`Description`/`Keywords` tags are
 * already plain strings/arrays, so they're trivially mappable without the
 * numeric reformatting the `exif.*` fields need.
 */
async function readExifToolTags(buf: Buffer): Promise<Tags> {
  const ext = CONTAINER_EXTENSION[detectContainer(buf)];
  return withTempFile(buf, ext, (file) => exiftool.read(file));
}

/**
 * Resolves image dimensions via sharp, translating a HEIC decode failure
 * into an actionable message. This build's sharp/libheif only supports
 * AVIF as a HEIF-family *input* (confirmed empirically: `sharp.format.heif
 * .input.fileSuffix` is `[".avif"]` only) — genuine HEIC throws a raw
 * libvips/libheif error ("Invalid input: Unspecified: No meta box found",
 * or similar). Since `social.opencontent.photograph`'s `aspectRatio` is a
 * required field, a dimensionless prefill is not an option — honest
 * rejection with a message the upload UI can surface verbatim is.
 */
async function getDimensions(buf: Buffer): Promise<{ width: number; height: number }> {
  try {
    const metadata = await sharp(buf).metadata();
    if (typeof metadata.width === "number" && typeof metadata.height === "number") {
      return { width: metadata.width, height: metadata.height };
    }
    throw new Error("could not determine image dimensions");
  } catch (err) {
    if (detectContainer(buf) === "heic") {
      throw new Error("this build cannot decode HEIC — export as JPEG from Lightroom");
    }
    throw err;
  }
}

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

function firstStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((t): t is string => typeof t === "string");
  return strings.length > 0 ? strings : undefined;
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
 * Photographers read shutter speed as a fraction below one second ("1/250")
 * and as plain seconds with a unit suffix at or above it ("2.5s") — so we
 * reformat rather than pass the raw decimal through.
 */
function formatShutterSpeed(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  if (value < 1) return `1/${Math.round(1 / value)}`;
  return `${Number(value.toFixed(2))}s`;
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
 * `exifr` is the primary metadata source (per the module's original design),
 * but it has no RIFF/WebP parser at all (confirmed empirically — it throws
 * "Unknown file format" on WebP input). Two things compensate for that gap:
 * `hasGps` is always resolved via `exiftool.read`, which reads GPS from
 * every container we accept, never from exifr's output — so it can never
 * be a silent false negative. And when exifr returns nothing, title/
 * description/tags fall back to exiftool's tags, which are trivially
 * mappable (plain strings/arrays, no numeric reformatting). The `exif.*`
 * sub-fields (camera/lens/focalLength/fNumber/shutterSpeed/iso) remain
 * exifr-sourced only and are left empty in that fallback case.
 *
 * Dimensions come from sharp and can throw — see `getDimensions` for the
 * HEIC-specific honest-rejection behavior.
 */
export async function extractPrefill(buf: Buffer): Promise<Prefill> {
  const { width, height } = await getDimensions(buf);

  const [parsed, tags] = await Promise.all([
    exifr.parse(buf, { iptc: true, tiff: true, exif: true, gps: true, xmp: true }).catch(() => undefined),
    readExifToolTags(buf).catch(() => undefined),
  ]);

  const data = (parsed ?? {}) as Record<string, unknown>;
  const t = tags ?? ({} as Tags);

  const title = firstString(data.title) ?? firstString(t.Title);
  const description =
    firstString(data.description) ?? firstString(data.ImageDescription) ?? firstString(t.Description) ?? firstString(t.ImageDescription);
  const tagList = firstStringArray(data.subject) ?? firstStringArray(t.Keywords) ?? [];

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

  // Authoritative GPS check: exiftool reads every accepted container
  // (including WebP, which exifr cannot parse at all), so this can never be
  // a silent false negative the way an exifr-only check would be.
  const hasGps = typeof t.GPSLatitude === "number" && typeof t.GPSLongitude === "number";

  const prefill: Prefill = { tags: tagList, exif, width, height, hasGps };
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
 * strip" case, with no separate short-circuit needed (and no dependency on
 * exifr's incomplete container support for that decision).
 */
export async function stripGps(buf: Buffer): Promise<Buffer> {
  const container = detectContainer(buf);
  if (container === "avif") {
    throw new Error("gps strip unsupported for avif; re-export without location");
  }
  if (container === "unknown") {
    throw new Error("gps strip unsupported for this image container; re-export without location");
  }

  return withTempFile(buf, CONTAINER_EXTENSION[container], async (file) => {
    await exiftool.write(file, {}, { writeArgs: ["-gps:all=", "-overwrite_original"] });
    return readFile(file);
  });
}
