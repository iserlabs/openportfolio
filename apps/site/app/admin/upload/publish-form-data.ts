/**
 * Builds the `FormData` `publishPhotograph` expects, from the upload form's
 * per-file editable fields. Pure aside from `FormData`/`File` themselves
 * (both ambient Web APIs, present in both the browser and this repo's
 * Vitest run -- Node's own `undici`-backed globals -- so this is testable
 * without a DOM). Empty-string fields are omitted rather than set to `""`,
 * matching `publishPhotographCore`'s own `stringField` helper, which treats
 * an empty string the same as an absent field.
 */
export interface PublishFields {
  title: string;
  description: string;
  alt: string;
  tags: string;
  license: string;
  location: string;
  capturedAt: string;
  keepGps: boolean;
}

export function buildPublishFormData(file: File, fields: PublishFields): FormData {
  const fd = new FormData();
  fd.set("file", file);
  if (fields.title) fd.set("title", fields.title);
  if (fields.description) fd.set("description", fields.description);
  if (fields.alt) fd.set("alt", fields.alt);
  if (fields.tags) fd.set("tags", fields.tags);
  if (fields.license) fd.set("license", fields.license);
  if (fields.location) fd.set("location", fields.location);
  if (fields.capturedAt) fd.set("capturedAt", fields.capturedAt);
  if (fields.keepGps) fd.set("keepGps", "true");
  return fd;
}
