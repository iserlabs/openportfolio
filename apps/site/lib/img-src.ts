import { blobUrl } from "./pds";

/**
 * Builds the `src` URL for a photograph's image, given its blob `cid`.
 *
 * STUBBED for A8 to the raw pinned-PDS blob URL (`blobUrl`) -- A9 lands the
 * real `/img/...` re-encoding proxy route (spec §9's "re-encoded image
 * serving" invariant: the PDS blob is never meant to be served to browsers
 * directly in the finished design, only through that proxy, which can also
 * offer multiple size renditions). Every caller that needs an image URL --
 * `PhotoGrid`/`PhotoCard`, the photograph detail page, and OG `image` tags --
 * goes through this single function, so swapping in the real proxy path
 * later is a one-function change here, not a find-and-replace across the
 * app.
 */
export function imgSrc(cid: string): string {
  return blobUrl(cid);
}
