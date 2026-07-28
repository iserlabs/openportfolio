import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exiftool, type Tags } from "exiftool-vendored";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractPrefill, stripGps } from "./photo-metadata";

// --- fixture helpers ---------------------------------------------------
//
// Fixtures are generated at test time (never committed binaries): a tiny
// sharp-created image, with metadata written on top via exiftool-vendored.
// exiftool-vendored keeps a live child process pool alive for the life of
// the module; it MUST be shut down in afterAll or the test runner hangs.

const WIDTH = 64;
const HEIGHT = 40;

async function withTempFile<T>(buf: Buffer, ext: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "photo-metadata-test-"));
  const file = path.join(dir, `fixture${ext}`);
  try {
    await writeFile(file, buf);
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Writes `tags` onto `buf` (a JPEG/PNG/WEBP/AVIF byte buffer) via exiftool and returns the resulting bytes. */
async function writeTags(buf: Buffer, ext: string, tags: Record<string, unknown>): Promise<Buffer> {
  return withTempFile(buf, ext, async (file) => {
    await exiftool.write(file, tags, { writeArgs: ["-overwrite_original"] });
    return readFile(file);
  });
}

/** Reads back tags via exiftool (test-only helper, independent of our own extraction code). */
async function readTags(buf: Buffer, ext: string): Promise<Tags> {
  return withTempFile(buf, ext, (file) => exiftool.read(file));
}

async function baseJpeg(width = WIDTH, height = HEIGHT): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#357" } })
    .jpeg()
    .toBuffer();
}

/**
 * A syntactically valid ISOBMFF `ftyp` box declaring the HEIC major brand,
 * padded with zero bytes. Real HEIC files use this same box structure, but
 * this fixture is otherwise not a decodable image — which is exactly what
 * we need: it lets `detectContainer` classify it as "heic" (byte-signature
 * sniffing needs only the `ftyp` box) while still reliably triggering
 * sharp's decode failure in an environment whose libheif build has no HEIC
 * decoder, without needing a real HEVC-encoded fixture.
 */
function fakeHeicBuffer(): Buffer {
  const type = Buffer.from("ftyp", "ascii");
  const majorBrand = Buffer.from("heic", "ascii");
  const minorVersion = Buffer.alloc(4);
  const compatibleBrands = Buffer.concat([Buffer.from("mif1", "ascii"), Buffer.from("heic", "ascii")]);
  const boxBody = Buffer.concat([type, majorBrand, minorVersion, compatibleBrands]);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(4 + boxBody.length, 0);
  return Buffer.concat([sizeBuf, boxBody, Buffer.alloc(128)]);
}

describe("photo-metadata", () => {
  let geotagged: Buffer;
  let plain: Buffer;

  beforeAll(async () => {
    const base = await baseJpeg();
    geotagged = await writeTags(base, ".jpg", {
      GPSLatitude: 40.7,
      GPSLongitude: -73.9,
      Title: "Main Street",
      Description: "Subway platform",
      Keywords: ["street", "nyc"],
      Make: "FUJIFILM",
      Model: "X-T5",
      LensModel: "XF 35mm",
      FNumber: 2.8,
      ExposureTime: "1/250",
      ISO: 800,
      FocalLength: "35 mm",
      DateTimeOriginal: "2026:05:01 10:00:00",
    });
    // Fixture (d): same camera metadata, deliberately no GPS.
    plain = await writeTags(base, ".jpg", { Make: "FUJIFILM", Model: "X-T5" });
  }, 30_000);

  afterAll(async () => {
    // exiftool-vendored keeps a child-process pool alive; without this the
    // vitest process never exits.
    await exiftool.end();
  });

  describe("extractPrefill", () => {
    it("prefills title, description, tags, exif fields, dimensions, and hasGps from a geotagged JPEG", async () => {
      const result = await extractPrefill(geotagged);

      expect(result.title).toBe("Main Street");
      expect(result.description).toBe("Subway platform");
      expect(result.tags).toEqual(["street", "nyc"]);
      expect(result.width).toBe(WIDTH);
      expect(result.height).toBe(HEIGHT);
      expect(result.hasGps).toBe(true);

      // Spec-exact exif shape: fNumber is a STRING, iso is an integer.
      expect(result.exif.fNumber).toBe("2.8");
      expect(typeof result.exif.fNumber).toBe("string");
      expect(result.exif.iso).toBe(800);
      expect(Number.isInteger(result.exif.iso)).toBe(true);

      expect(result.exif.shutterSpeed).toBe("1/250");
      expect(result.exif.camera).toBe("FUJIFILM X-T5");
      expect(result.exif.lens).toBe("XF 35mm");
      expect(result.exif.focalLength).toBe("35mm");

      // Environment-independent: exifr resolves DateTimeOriginal against the
      // system's local timezone, so only the calendar day is asserted (10am
      // is nowhere near a midnight boundary in either UTC or US timezones).
      expect(result.capturedAt).toMatch(/^2026-05-01T/);
    });

    it("returns hasGps: false for a non-geotagged JPEG", async () => {
      const result = await extractPrefill(plain);
      expect(result.hasGps).toBe(false);
      expect(result.width).toBe(WIDTH);
      expect(result.height).toBe(HEIGHT);
      expect(result.exif.camera).toBe("FUJIFILM X-T5");
    });

    it("formats shutter speeds of one second or longer as plain seconds with an 's' suffix", async () => {
      const base = await baseJpeg(8, 8);
      const slow = await writeTags(base, ".jpg", { ExposureTime: "2.5" });
      const result = await extractPrefill(slow);
      expect(result.exif.shutterSpeed).toBe("2.5s");
    });

    // exifr has no RIFF/WebP parser (confirmed empirically: it throws
    // "Unknown file format" on WebP input), so an exifr-only GPS check is a
    // silent false negative for GPS-tagged WebP uploads. hasGps must be
    // resolved via exiftool (which reads GPS from every accepted
    // container) so this can never happen.
    it("returns hasGps: true for a geotagged WebP, and falls back to exiftool-derived title when exifr can't parse the container", async () => {
      const base = await sharp({ create: { width: 20, height: 15, channels: 3, background: "#357" } })
        .webp()
        .toBuffer();
      const geotaggedWebp = await writeTags(base, ".webp", {
        GPSLatitude: 40.7,
        GPSLongitude: -73.9,
        Title: "Dock",
        Description: "Sunset dock",
        Keywords: ["dock", "sunset"],
        Make: "FUJIFILM",
      });

      const result = await extractPrefill(geotaggedWebp);
      expect(result.hasGps).toBe(true);
      expect(result.width).toBe(20);
      expect(result.height).toBe(15);
      // Trivially-mappable fallback fields sourced from exiftool, since
      // exifr returns nothing at all for WebP.
      expect(result.title).toBe("Dock");
      expect(result.description).toBe("Sunset dock");
      expect(result.tags).toEqual(["dock", "sunset"]);
    });

    it("throws an actionable message for HEIC input rather than a raw decode error", async () => {
      await expect(extractPrefill(fakeHeicBuffer())).rejects.toThrow(
        "this build cannot decode HEIC — export as JPEG from Lightroom",
      );
    });
  });

  describe("stripGps", () => {
    it("removes GPS tags while preserving other metadata", async () => {
      const stripped = await stripGps(geotagged);
      const tags = await readTags(stripped, ".jpg");

      expect(tags.GPSLatitude).toBeUndefined();
      expect(tags.GPSLongitude).toBeUndefined();
      expect(tags.Make).toBe("FUJIFILM");
      expect(tags.Model).toBe("X-T5");
    });

    // Hard requirement: GPS strip is metadata-only surgery. Masters are never
    // recompressed — decoded pixel data must be byte-identical after strip.
    it("is pixel-identical to the original after stripping (metadata-only surgery)", async () => {
      const stripped = await stripGps(geotagged);
      const rawBefore = await sharp(geotagged).raw().toBuffer();
      const rawAfter = await sharp(stripped).raw().toBuffer();
      expect(Buffer.compare(rawBefore, rawAfter)).toBe(0);
    });

    it("is a byte-identical no-op passthrough for a non-geotagged JPEG", async () => {
      const result = await stripGps(plain);
      expect(Buffer.compare(result, plain)).toBe(0);
    });

    // Honest failure over silent pass-through: exiftool's AVIF write support
    // is unreliable, so we refuse rather than risk leaving GPS in place.
    it("throws for AVIF rather than risk a silent GPS pass-through", async () => {
      const avifBase = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#357" } })
        .avif()
        .toBuffer();
      const avifGeotagged = await writeTags(avifBase, ".avif", { GPSLatitude: 40.7, GPSLongitude: -73.9 });

      await expect(stripGps(avifGeotagged)).rejects.toThrow(/avif/i);
    });

    it("throws for an unrecognized container rather than silently passing GPS through", async () => {
      const bogus = Buffer.from("this is not an image file, just plain text padding for length");
      await expect(stripGps(bogus)).rejects.toThrow(/unsupported/i);
    });

    // Deferred: this environment's sharp/libheif build can neither encode
    // nor decode HEVC (`sharp().heif({ compression: "hevc" })` fails with
    // "Unsupported compression"), so no real HEIC fixture can be generated
    // here to exercise stripGps's HEIC code path end-to-end. The container
    // detection and exiftool delegation are implemented (see
    // CONTAINER_EXTENSION / detectContainer in photo-metadata.ts) but are
    // unverified against real HEIC bytes.
    it.todo(
      "strips GPS from real HEIC input and preserves pixels (deferred: environment cannot encode/decode HEVC to build a fixture)",
    );
  });

  describe.each([
    {
      name: "PNG",
      ext: ".png",
      makeBase: () => sharp({ create: { width: 20, height: 15, channels: 3, background: "#357" } }).png().toBuffer(),
    },
    {
      name: "WebP",
      ext: ".webp",
      makeBase: () => sharp({ create: { width: 20, height: 15, channels: 3, background: "#357" } }).webp().toBuffer(),
    },
  ])("stripGps ($name)", ({ ext, makeBase }) => {
    let geotaggedOther: Buffer;

    beforeAll(async () => {
      const base = await makeBase();
      geotaggedOther = await writeTags(base, ext, {
        GPSLatitude: 40.7,
        GPSLongitude: -73.9,
        Make: "FUJIFILM",
        Model: "X-T5",
      });
    }, 30_000);

    it("removes GPS tags while preserving other metadata", async () => {
      const stripped = await stripGps(geotaggedOther);
      const tags = await readTags(stripped, ext);

      expect(tags.GPSLatitude).toBeUndefined();
      expect(tags.GPSLongitude).toBeUndefined();
      expect(tags.Make).toBe("FUJIFILM");
      expect(tags.Model).toBe("X-T5");
    });

    it("is pixel-identical to the original after stripping (metadata-only surgery)", async () => {
      const stripped = await stripGps(geotaggedOther);
      const rawBefore = await sharp(geotaggedOther).raw().toBuffer();
      const rawAfter = await sharp(stripped).raw().toBuffer();
      expect(Buffer.compare(rawBefore, rawAfter)).toBe(0);
    });
  });
});
