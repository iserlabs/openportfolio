/**
 * Extracts the blob's CID string from a `social.opencontent.photograph`
 * record's `image.ref`, as it actually arrives over the wire from
 * `com.atproto.repo.listRecords`/`getRecord` (plain JSON via `lib/pds.ts`'s
 * `fetch`-based reader, never a real `@atproto/lexicon` `BlobRef` class
 * instance): `{ $link: "bafy..." }`. Mirrors Luminance's
 * `packages/atproto/src/mappers/types.ts`'s `blobCid`. Needed so pages can
 * build an image `src` via `lib/img-src.ts`'s `imgSrc(cid)` (the
 * `/img/[cid]/[preset]` re-encoding proxy).
 */
export function blobRefCid(ref: unknown): string | undefined {
  if (ref && typeof ref === "object" && "$link" in ref) {
    const link = (ref as { $link: unknown }).$link;
    if (typeof link === "string" && link.length > 0) return link;
  }
  return undefined;
}
