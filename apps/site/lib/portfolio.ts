import {
  OPENCONTENT_COLLECTION,
  OPENCONTENT_PHOTOGRAPH,
  OPENCONTENT_SITE,
  type CollectionRecord,
  type PhotographRecord,
  type SiteRecord,
} from "@open-portfolio/lexicons";
import { rkeyFromUri } from "./at-uri";
import { cached as sharedCached, getRecord as sharedGetRecord, listAllRecords as sharedListAllRecords, type RecordEnvelope } from "./pds";

/**
 * The single read model every public page renders from (spec §9: public
 * pages read only through `getPortfolio()`, never `lib/pds.ts` directly).
 * `collections` is pre-ordered (see {@link assemblePortfolio}); `photographs`
 * is keyed by `rkey` for O(1) lookup on `/p/[rkey]`, each value carrying the
 * *record's own* `cid` (the same convention as
 * `app/admin/collections/page.tsx`'s `PhotographOption` -- the ATProto record
 * cid from `listRecords`, not the image blob's cid; get that separately via
 * `blobRefCid(photograph.image.ref)`).
 */
export interface OrderedCollection {
  rkey: string;
  cid: string;
  record: CollectionRecord;
}

export interface Portfolio {
  site: SiteRecord | null;
  collections: OrderedCollection[];
  photographs: Map<string, PhotographRecord & { cid: string }>;
}

const PORTFOLIO_CACHE_KEY = "portfolio";
const PORTFOLIO_TTL_MS = 60_000;

type GetRecordFn = typeof sharedGetRecord;
type ListAllRecordsFn = typeof sharedListAllRecords;
type CachedFn = typeof sharedCached;

export interface PortfolioDeps {
  getRecord: GetRecordFn;
  listAllRecords: ListAllRecordsFn;
  cached: CachedFn;
}

const defaultDeps: PortfolioDeps = {
  getRecord: sharedGetRecord,
  listAllRecords: sharedListAllRecords,
  cached: sharedCached,
};

/**
 * Assembles the portfolio read model from freshly-fetched records, then
 * caches it for {@link PORTFOLIO_TTL_MS} via `lib/pds.ts`'s shared, singleton
 * `cached()` store -- the same store admin actions bust (with no prefix, so
 * unconditionally) on every publish/save/delete, which is what makes a
 * publish visible on the public site immediately rather than up to 60s
 * later. `deps` defaults to the real `pds.ts` functions; tests inject
 * stand-ins so the ordering/dangling-ref logic below is exercised without
 * touching that real singleton cache (see `assemblePortfolio`, tested
 * directly and more thoroughly for that reason).
 */
export async function getPortfolio(deps: Partial<PortfolioDeps> = {}): Promise<Portfolio> {
  const { getRecord, listAllRecords, cached } = { ...defaultDeps, ...deps };

  return cached(PORTFOLIO_CACHE_KEY, PORTFOLIO_TTL_MS, async () => {
    const [siteEnvelope, collectionEnvelopes, photographEnvelopes] = await Promise.all([
      getRecord<SiteRecord>(OPENCONTENT_SITE, "self"),
      listAllRecords<CollectionRecord>(OPENCONTENT_COLLECTION),
      listAllRecords<PhotographRecord>(OPENCONTENT_PHOTOGRAPH),
    ]);

    return assemblePortfolio(siteEnvelope?.value ?? null, collectionEnvelopes, photographEnvelopes);
  });
}

/**
 * Pure core of {@link getPortfolio}: applies the spec's ordering rule --
 * collections named in `site.collectionOrder` come first, in that exact
 * order; a `collectionOrder` rkey with no matching collection (deleted since
 * the order was last saved) is dropped silently, never thrown; every
 * collection NOT named in `collectionOrder` (freshly created, or no site
 * record/collectionOrder at all) is appended after, newest-first by
 * `createdAt`. Also builds the `photographs` lookup map. No dangling-item
 * resolution happens here -- a collection's own `items[]` are only resolved
 * against `photographs` on demand, by {@link collectionPhotographs}.
 */
export function assemblePortfolio(
  site: SiteRecord | null,
  collectionEnvelopes: RecordEnvelope<CollectionRecord>[],
  photographEnvelopes: RecordEnvelope<PhotographRecord>[],
): Portfolio {
  return {
    site,
    collections: orderCollections(site, collectionEnvelopes),
    photographs: buildPhotographsMap(photographEnvelopes),
  };
}

function orderCollections(
  site: SiteRecord | null,
  collectionEnvelopes: RecordEnvelope<CollectionRecord>[],
): OrderedCollection[] {
  const byRkey = new Map<string, RecordEnvelope<CollectionRecord>>();
  for (const envelope of collectionEnvelopes) {
    byRkey.set(rkeyFromUri(envelope.uri), envelope);
  }

  const ordered: OrderedCollection[] = [];
  const used = new Set<string>();

  for (const rkey of site?.collectionOrder ?? []) {
    if (used.has(rkey)) continue; // defensive de-dupe -- a repeated rkey in collectionOrder
    const envelope = byRkey.get(rkey);
    if (!envelope) continue; // dangling collectionOrder entry -- skip silently, never throw
    ordered.push({ rkey, cid: envelope.cid, record: envelope.value });
    used.add(rkey);
  }

  const unlisted = collectionEnvelopes
    .filter((envelope) => !used.has(rkeyFromUri(envelope.uri)))
    .slice()
    .sort((a, b) => (b.value.createdAt ?? "").localeCompare(a.value.createdAt ?? "")); // newest first

  for (const envelope of unlisted) {
    ordered.push({ rkey: rkeyFromUri(envelope.uri), cid: envelope.cid, record: envelope.value });
  }

  return ordered;
}

function buildPhotographsMap(
  photographEnvelopes: RecordEnvelope<PhotographRecord>[],
): Map<string, PhotographRecord & { cid: string }> {
  const map = new Map<string, PhotographRecord & { cid: string }>();
  for (const envelope of photographEnvelopes) {
    map.set(rkeyFromUri(envelope.uri), { ...envelope.value, cid: envelope.cid });
  }
  return map;
}

/**
 * Resolves a collection's ordered `items` strongRefs against the
 * portfolio-wide `photographs` map, preserving `items`' own order. An item
 * whose target photograph no longer exists (deleted since the collection
 * was last saved -- a "dangling ref") resolves to nothing and is dropped
 * from the result silently; it is never an error, matching the same
 * tolerance `deleteRecordActionCore` already has to guard against on the
 * write side (blocking deletes of *referenced* photographs unless forced --
 * this is the read-side complement for refs that slipped through anyway,
 * e.g. a forced delete).
 */
export function collectionPhotographs(
  collection: CollectionRecord,
  photographs: Map<string, PhotographRecord & { cid: string }>,
): { rkey: string; photograph: PhotographRecord & { cid: string } }[] {
  const out: { rkey: string; photograph: PhotographRecord & { cid: string } }[] = [];
  for (const item of collection.items) {
    const rkey = rkeyFromUri(item.uri);
    const photograph = photographs.get(rkey);
    if (photograph) out.push({ rkey, photograph });
  }
  return out;
}

/** Resolves a collection's optional `cover` strongRef, returning `null` for both "no cover set" and a dangling cover ref -- never throws. */
export function collectionCover(
  collection: CollectionRecord,
  photographs: Map<string, PhotographRecord & { cid: string }>,
): (PhotographRecord & { cid: string }) | null {
  if (!collection.cover) return null;
  return photographs.get(rkeyFromUri(collection.cover.uri)) ?? null;
}

export interface HomeFeed {
  collection: OrderedCollection | null;
  photographs: { rkey: string; photograph: PhotographRecord & { cid: string } }[];
}

/**
 * The home page's feed selection rule (spec): the first collection in
 * ordered position, showing its own resolved photographs -- or, when there
 * are no collections at all, every photograph in the repo, newest-first.
 */
export function homeFeed(portfolio: Portfolio): HomeFeed {
  const first = portfolio.collections[0];
  if (first) {
    return { collection: first, photographs: collectionPhotographs(first.record, portfolio.photographs) };
  }

  const all = Array.from(portfolio.photographs.entries())
    .map(([rkey, photograph]) => ({ rkey, photograph }))
    .sort((a, b) => (b.photograph.createdAt ?? "").localeCompare(a.photograph.createdAt ?? ""));
  return { collection: null, photographs: all };
}

export interface PhotoNeighbors {
  collection: OrderedCollection | null;
  prevRkey: string | null;
  nextRkey: string | null;
}

/**
 * Finds `rkey`'s previous/next sibling within the first ordered collection
 * that contains it (a photograph can appear in more than one collection;
 * the first one in nav order wins, arbitrarily but deterministically). Only
 * ever consults data `getPortfolio()` already fetched -- no extra PDS calls
 * -- which is what makes this "cheap enough" to always compute rather than
 * skip, per the brief's "prev/next within its collection context if cheap,
 * else skip." Returns all-null when the photograph is in no collection.
 */
export function neighborsInCollection(portfolio: Portfolio, rkey: string): PhotoNeighbors {
  for (const collection of portfolio.collections) {
    const items = collectionPhotographs(collection.record, portfolio.photographs);
    const index = items.findIndex((item) => item.rkey === rkey);
    if (index === -1) continue;
    return {
      collection,
      prevRkey: index > 0 ? items[index - 1].rkey : null,
      nextRkey: index < items.length - 1 ? items[index + 1].rkey : null,
    };
  }
  return { collection: null, prevRkey: null, nextRkey: null };
}
