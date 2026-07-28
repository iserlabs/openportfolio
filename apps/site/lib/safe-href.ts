/**
 * Sanitizes a user-supplied URL (the site settings form's `links[].uri`) —
 * only `http:`/`https:` survive, blocking `javascript:`, `data:`, and other
 * schemes that would execute or render as script if ever rendered as an
 * href on the public site. Mirrors Luminance's `apps/web/lib/safe-href.ts`
 * exactly (spec §9's "scheme-checked external hrefs" security invariant),
 * applied here at write time in the site settings form so an unsafe scheme
 * can never even be saved into the `social.opencontent.site` record.
 */
export function safeExternalHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}
