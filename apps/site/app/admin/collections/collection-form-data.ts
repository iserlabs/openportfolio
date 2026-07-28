/** A `com.atproto.repo.strongRef`-shaped value, as the collection editor deals in it (a photograph's `{uri, cid}`). */
export interface StrongRefLike {
  uri: string;
  cid: string;
}

export interface CollectionFormFields {
  rkey?: string;
  title: string;
  description: string;
  items: StrongRefLike[];
  cover?: StrongRefLike;
}

/**
 * Builds the single `FormData` `saveCollection` expects from the collection
 * editor's draft state: an `rkey` field present only when editing an
 * existing collection (its absence is what tells `saveCollectionCore` to
 * `createRecord` instead of `putRecord`), `items` as a JSON-encoded ordered
 * array (drag-reorder is just resubmitting the same set in a new order),
 * and `cover` as a JSON-encoded single strongRef, omitted entirely when
 * unset.
 */
export function buildCollectionFormData(input: CollectionFormFields): FormData {
  const fd = new FormData();
  if (input.rkey) fd.set("rkey", input.rkey);
  fd.set("title", input.title);
  if (input.description) fd.set("description", input.description);
  fd.set("items", JSON.stringify(input.items));
  if (input.cover) fd.set("cover", JSON.stringify(input.cover));
  return fd;
}
