/**
 * Extracts the trailing record key from an `at://did/collection/rkey` URI —
 * the shape every `com.atproto.repo.*` response's `uri` field takes. The
 * admin UI needs the bare `rkey` (not the full URI) for `deleteRecordAction`/
 * `saveCollection`'s `rkey` form fields, whose FormData contract takes a
 * plain record key, not a URI.
 */
export function rkeyFromUri(uri: string): string {
  const rkey = uri.split("/").pop();
  if (!rkey) throw new Error(`could not extract rkey from uri: ${uri}`);
  return rkey;
}
