export interface SiteLinkLike {
  label: string;
  uri: string;
}

export interface SiteFormFields {
  title: string;
  about: string;
  theme: string;
  collectionOrder: string[];
  links: SiteLinkLike[];
}

/**
 * Builds the single `FormData` `saveSite` expects. `links` is filtered down
 * to fully-filled-in rows (both label and uri present) before encoding —
 * the editor lets the owner add a blank row to start typing, and a
 * half-filled row shouldn't get written as a broken link. `collectionOrder`
 * is JSON-encoded even when empty (`saveSiteCore`'s own default for an
 * absent field), so an intentional "no nav order yet" round-trips as `[]`,
 * not as the field being silently omitted.
 */
export function buildSiteFormData(input: SiteFormFields): FormData {
  const fd = new FormData();
  fd.set("title", input.title);
  if (input.about) fd.set("about", input.about);
  if (input.theme) fd.set("theme", input.theme);
  fd.set("collectionOrder", JSON.stringify(input.collectionOrder));
  const links = input.links.filter((l) => l.label.trim().length > 0 && l.uri.trim().length > 0);
  fd.set("links", JSON.stringify(links));
  return fd;
}
