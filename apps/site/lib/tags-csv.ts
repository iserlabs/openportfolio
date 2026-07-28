/**
 * Tags round-trip through the admin UI as a single comma-separated text
 * input (matching `publishPhotographCore`'s own `parseCsvTags` split/trim/
 * filter logic in `app/admin/actions.ts`), while `extractPrefill`/
 * `buildPhotograph` both deal in `string[]`. These two pure functions are
 * the client-side half of that round trip: `formatTagsCsv` seeds the input
 * from a prefill's `tags: string[]`, `parseTagsCsv` turns the edited text
 * back into an array for client-side display (e.g. a live tag count) —
 * the actual submit just sends the raw CSV string, which the server parses
 * itself.
 */
export function formatTagsCsv(tags: string[]): string {
  return tags.join(", ");
}

export function parseTagsCsv(value: string): string[] {
  return value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}
