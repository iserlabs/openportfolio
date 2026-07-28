import type Database from "better-sqlite3";
import sharp from "sharp";
import { blobRefCid } from "./blob-ref";
import { blobUrl } from "./pds";
import { getPortfolio as sharedGetPortfolio, type Portfolio } from "./portfolio";

/**
 * Ported from `~/workspace/luminance.social/apps/web/lib/image-proxy.ts`.
 *
 * `grid` exists for high-DPR phones: a 412px viewport at DPR 1.75 needs
 * ~720 device px, and without it the srcset jumps 512 -> 1024, forcing the
 * full feed rendition over throttled mobile links.
 */
export const PRESETS = { thumb: 512, grid: 768, feed: 1024, full: 2048 } as const;
export type Preset = keyof typeof PRESETS;

interface Deps {
  fetchBlob?: (cid: string) => Promise<Buffer>;
  getPortfolio?: () => Promise<Portfolio>;
}

async function defaultFetchBlob(cid: string): Promise<Buffer> {
  // blobUrl() is pinned to env.PDS_URL -- no DID resolution, no caller-
  // controlled origin, no SSRF surface (spec's "pinned-host blob fetches").
  const res = await fetch(blobUrl(cid), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`getBlob ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Allowlist (spec §11, adapted for single-owner): a cid may only be proxied
 * if it is some photograph's blob cid. Collection covers need no separate
 * check -- a collection's `cover` is a strongRef to a photograph record, so
 * the cover's image cid is already a member of `photographs` by
 * construction. `getPortfolio()` is cached (60s TTL, busted on every admin
 * write), so this never hits the PDS directly per request.
 */
function isAllowedCid(portfolio: Portfolio, cid: string): boolean {
  for (const photograph of portfolio.photographs.values()) {
    if (blobRefCid(photograph.image.ref) === cid) return true;
  }
  return false;
}

export async function proxyImage(
  db: Database.Database,
  req: { cid: string; preset: Preset; accept: string },
  deps: Deps = {},
) {
  // Object.prototype.hasOwnProperty guards against a `preset` of
  // "constructor"/"toString"/etc. resolving to an inherited Object.prototype
  // member instead of `undefined`.
  const width = Object.prototype.hasOwnProperty.call(PRESETS, req.preset)
    ? PRESETS[req.preset]
    : undefined;
  if (!width) return { status: 400, cacheControl: "public, max-age=3600" };

  const portfolio = await (deps.getPortfolio ?? sharedGetPortfolio)();
  if (!isAllowedCid(portfolio, req.cid)) {
    // 404 before any upstream fetch -- the allowlist check never touches the PDS.
    return { status: 404, cacheControl: "public, max-age=300" };
  }

  // Guarded read: only generate + write the blur-up placeholder when this
  // cid doesn't already have one (mirrors Luminance's guarded write). The
  // INSERT below is additionally guarded with OR IGNORE so a concurrent
  // first-request race still can't overwrite a placeholder another request
  // just wrote.
  const existingBlur = db.prepare("SELECT 1 FROM blur WHERE cid = ?").get(req.cid);
  const hasBlur = Boolean(existingBlur);

  try {
    const buf = await (deps.fetchBlob ?? defaultFetchBlob)(req.cid);
    const wantsAvif = req.accept.includes("image/avif");
    const wantsWebp = req.accept.includes("image/webp");
    let pipe = sharp(buf).rotate().resize({ width, withoutEnlargement: true });
    // Small presets (grid tiles) trade a little quality for mobile LCP; feed/full
    // keep detail-page quality untouched.
    const small = width <= PRESETS.grid;
    pipe = wantsAvif
      ? pipe.avif({ quality: small ? 60 : 70 })
      : wantsWebp
        ? pipe.webp({ quality: small ? 75 : 82 })
        : pipe.jpeg({ quality: small ? 78 : 85 });
    const body = await pipe.toBuffer();

    // Blur-up placeholder: the blob is decoded right here anyway, so the
    // first successful serve of a photo also emits a ~16px webp data URI and
    // stores it in the `blur` table, keyed by cid. Best-effort -- a
    // placeholder failure must never fail a good image response.
    if (!hasBlur) {
      try {
        const tiny = await sharp(buf)
          .rotate()
          .resize({ width: 16, withoutEnlargement: true })
          .webp({ quality: 40 })
          .toBuffer();
        db.prepare("INSERT OR IGNORE INTO blur (cid, data_url) VALUES (?, ?)").run(
          req.cid,
          `data:image/webp;base64,${tiny.toString("base64")}`,
        );
      } catch {
        // best-effort -- never fail the real image response over this
      }
    }

    return {
      status: 200,
      body,
      contentType: wantsAvif ? "image/avif" : wantsWebp ? "image/webp" : "image/jpeg",
      cacheControl: "public, max-age=31536000, immutable",
    };
  } catch {
    return { status: 502, cacheControl: "public, max-age=30" }; // negative cache
  }
}
