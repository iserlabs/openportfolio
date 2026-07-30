/**
 * Formats a photograph's `exif` sub-record (the same shape as
 * `@openportfolio/lexicons`' `Exif`) into a single human-readable line for
 * the upload form's read-only prefill summary — `exif` itself is never a
 * form field (it's always re-derived server-side from the uploaded bytes,
 * see `publishPhotographCore`), so this is display-only.
 */
export interface ExifSummaryInput {
  camera?: string;
  lens?: string;
  focalLength?: string;
  fNumber?: string;
  shutterSpeed?: string;
  iso?: number;
}

export function formatExifSummary(exif: ExifSummaryInput): string {
  const parts: string[] = [];
  if (exif.camera) parts.push(exif.camera);
  if (exif.lens) parts.push(exif.lens);
  if (exif.focalLength) parts.push(exif.focalLength);
  if (exif.fNumber) parts.push(`f/${exif.fNumber}`);
  if (exif.shutterSpeed) parts.push(exif.shutterSpeed);
  if (exif.iso !== undefined) parts.push(`ISO ${exif.iso}`);
  return parts.join(" · ");
}
