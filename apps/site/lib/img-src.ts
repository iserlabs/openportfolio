import { env } from "./env";
import type { Preset } from "./image-proxy";

export type { Preset };

/**
 * Builds the `src` URL for a photograph's image, given its blob `cid`.
 *
 * A9 repoints this at the real `/img/[cid]/[preset]` re-encoding proxy route
 * (spec §9's "re-encoded image serving" invariant: the PDS blob is never
 * served to browsers directly -- only through the proxy, which also offers
 * multiple size renditions and a blur-up placeholder). Every caller that
 * needs an image URL -- `PhotoGrid`/`PhotoCard`, the photograph detail page,
 * admin thumbnails, and OG `image` tags -- goes through this module, so a
 * future change to the proxy's URL shape is a one-place change.
 *
 * Relative, not absolute: browsers resolve `/img/...` against the current
 * origin fine, and it's the form every `<img src>`/`srcSet` in the app wants.
 * OG metadata needs an absolute URL instead -- see {@link absoluteImgSrc}.
 */
export function imgSrc(cid: string, preset: Preset = "feed"): string {
  return `/img/${encodeURIComponent(cid)}/${preset}`;
}

/**
 * `srcSet` spanning the grid tile renditions (thumb/grid/feed), matching
 * Luminance's `photo-grid.tsx`. `full` is reserved for the photograph detail
 * page's own larger srcSet (feed/full), built alongside {@link imgSrc} there.
 */
export function imgSrcSet(cid: string): string {
  const base = `/img/${encodeURIComponent(cid)}`;
  return `${base}/thumb 512w, ${base}/grid 768w, ${base}/feed 1024w`;
}

/**
 * Absolute form of {@link imgSrc}, for `openGraph.images` metadata only --
 * the Open Graph protocol requires a fully-qualified URL there. Deliberately
 * NOT done via Next's `metadataBase` (which would need to be set in the root
 * layout's static `metadata` export, evaluated at module-import time --
 * i.e. during `next build`, which must succeed with zero env vars set, same
 * constraint `lib/env.ts` documents). This function is only ever called from
 * inside a per-request `generateMetadata()`, where env access is already
 * established as safe (see e.g. `app/(public)/p/[rkey]/page.tsx`).
 */
export function absoluteImgSrc(cid: string, preset: Preset = "feed"): string {
  return `${env.PUBLIC_URL}${imgSrc(cid, preset)}`;
}
