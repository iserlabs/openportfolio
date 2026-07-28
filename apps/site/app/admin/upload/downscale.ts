/**
 * Client-side downscale, offered only after `publishPhotograph` rejects an
 * upload with `code: "too-large"` — the *only* place this product ever
 * recompresses a photograph (spec §9: masters are otherwise never
 * recompressed; `stripGps` is metadata-only surgery, byte-identical pixels).
 * It's an explicit, one-click user opt-in on an already-rejected upload, not
 * something applied automatically.
 *
 * Split into two pieces: the pure math (`estimateDownscaleDimensions`,
 * `parseTooLargeLimitBytes`) is unit-tested below with no DOM involved; the
 * actual re-encode (`canvasDownscale`) needs a real `<canvas>` and
 * `createImageBitmap`, neither available under this repo's plain-Node
 * Vitest run (no jsdom/canvas polyfill installed) — that half is exercised
 * by hand / A13's E2E harness instead.
 */

// describeTooLarge (app/admin/actions.ts) formats its human-readable message
// as "... (${rounded}MB) ..." when it can parse a byte limit out of the
// PDS's own error text, e.g. "(5MB)" or "(1.2MB)". The action's result never
// carries that limit as a separate machine-readable field (spec's
// `PublishResult` is just `{ok:false; error; code?}`), so this is the
// client-side inverse of that same formatting -- best-effort, not
// authoritative; `estimateDownscaleDimensions` below tolerates an unknown
// limit.
const TOO_LARGE_MB_HINT = /\(([\d.]+)\s*MB\)/i;

/** Recovers the PDS's byte limit from `publishPhotograph`'s `error` message, when parseable. Returns `undefined` for a generic (unparseable) too-large message. */
export function parseTooLargeLimitBytes(message: string | undefined): number | undefined {
  if (!message) return undefined;
  const match = message.match(TOO_LARGE_MB_HINT);
  if (!match) return undefined;
  const mb = Number(match[1]);
  if (!Number.isFinite(mb) || mb <= 0) return undefined;
  return Math.round(mb * 1024 * 1024);
}

// Leaves headroom below the parsed limit: re-encoding at quality 0.92 from a
// canvas doesn't reproduce the original encoder's bytes-per-pixel exactly,
// so targeting the limit exactly risks landing just over it again.
const SAFETY_MARGIN = 0.85;
// Never downscale the shorter edge below this, even for a very small parsed
// limit -- a usable (if not print-quality) image beats an unusable sliver.
const MIN_DIMENSION = 480;

/**
 * Estimates target dimensions to bring an image under `maxBytes`, assuming
 * (roughly true for photographic JPEG at a fixed quality) that encoded size
 * scales with pixel count. Always preserves aspect ratio exactly -- both
 * dimensions are scaled by the same factor, never independently clamped --
 * and never upscales (`pixelScale` is capped at 1).
 */
export function estimateDownscaleDimensions(
  width: number,
  height: number,
  currentBytes: number,
  maxBytes: number,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) throw new Error("width and height must be positive");
  if (!(currentBytes > 0) || !(maxBytes > 0)) throw new Error("currentBytes and maxBytes must be positive");

  const pixelScale = Math.min(1, (maxBytes * SAFETY_MARGIN) / currentBytes);
  let linearScale = Math.sqrt(pixelScale);

  const minScale = Math.min(1, MIN_DIMENSION / Math.min(width, height));
  linearScale = Math.max(linearScale, minScale);

  return {
    width: Math.max(1, Math.round(width * linearScale)),
    height: Math.max(1, Math.round(height * linearScale)),
  };
}

/**
 * Re-encodes `file` at `targetWidth`x`targetHeight` as JPEG via a canvas.
 * Browser-only (`createImageBitmap`, `document.createElement("canvas")`) —
 * not unit-tested here, see file-level note.
 */
export async function canvasDownscale(
  file: File | Blob,
  targetWidth: number,
  targetHeight: number,
  quality = 0.92,
): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("canvas image encode failed"))),
        "image/jpeg",
        quality,
      );
    });
  } finally {
    bitmap.close();
  }
}
