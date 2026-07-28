import { env } from "./env.js";

/**
 * Pinned PDS read client + in-process TTL cache.
 *
 * Every fetch here is built from `env.PDS_URL` only — `collection`/`rkey`
 * values are always interpolated as query-string *values*, never as a URL
 * origin, so a hostile `collection` string (e.g. containing `http://...`)
 * can never redirect a request to a different host.
 */

export type FetchJson = (url: string) => Promise<unknown>;

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`pds fetch ${url}: ${res.status}`);
  return res.json();
}

export interface RecordEnvelope<T> {
  uri: string;
  cid: string;
  value: T;
}

interface ListRecordsResponse {
  records: { uri: string; cid: string; value: unknown }[];
  cursor?: string;
}

interface GetRecordResponse {
  uri: string;
  cid: string;
  value: unknown;
}

const LIST_RECORDS_LIMIT = 100;
const LIST_RECORDS_HARD_CAP = 5000; // safety valve against a runaway/malicious cursor chain

/**
 * Pages `com.atproto.repo.listRecords` for `collection` in the pinned repo
 * (`env.OWNER_DID`) at `limit=100`, joining pages until the response omits
 * `cursor`. Hard-capped at 5000 records total — stops issuing further
 * requests once reached, rather than trusting an unbounded cursor chain.
 */
export async function listAllRecords<T>(
  collection: string,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<RecordEnvelope<T>[]> {
  const out: RecordEnvelope<T>[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      repo: env.OWNER_DID,
      collection,
      limit: String(LIST_RECORDS_LIMIT),
    });
    if (cursor) params.set("cursor", cursor);

    const url = `${env.PDS_URL}/xrpc/com.atproto.repo.listRecords?${params.toString()}`;
    const page = (await fetchJson(url)) as ListRecordsResponse;

    for (const r of page.records) {
      out.push({ uri: r.uri, cid: r.cid, value: r.value as T });
      if (out.length >= LIST_RECORDS_HARD_CAP) return out;
    }
    cursor = page.cursor;
  } while (cursor);

  return out;
}

/** Fetches a single record via `com.atproto.repo.getRecord` from the pinned repo. */
export async function getRecord<T>(
  collection: string,
  rkey: string,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<RecordEnvelope<T>> {
  const params = new URLSearchParams({ repo: env.OWNER_DID, collection, rkey });
  const url = `${env.PDS_URL}/xrpc/com.atproto.repo.getRecord?${params.toString()}`;
  const record = (await fetchJson(url)) as GetRecordResponse;
  return { uri: record.uri, cid: record.cid, value: record.value as T };
}

/** Builds a `com.atproto.sync.getBlob` URL against the pinned PDS_URL, percent-encoding both the DID and the cid. */
export function blobUrl(cid: string): string {
  const did = encodeURIComponent(env.OWNER_DID);
  const encodedCid = encodeURIComponent(cid);
  return `${env.PDS_URL}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${encodedCid}`;
}

// --- in-process TTL cache ---------------------------------------------------
//
// A single module-level Map: intentionally a process-wide singleton, not a
// per-caller instance. `bustCache` (called from admin actions on publish) and
// `cached` (called from public reads) must share the exact same store for the
// "publish is visible to the author immediately" invariant to hold.

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cacheStore = new Map<string, CacheEntry>();

/** Returns the cached value for `key` if still within `ttlMs`; otherwise calls `fn`, caches, and returns the fresh value. */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cacheStore.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  const value = await fn();
  cacheStore.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

/** Clears cache entries whose key starts with `prefix`, or every entry when `prefix` is omitted. */
export function bustCache(prefix?: string): void {
  if (prefix === undefined) {
    cacheStore.clear();
    return;
  }
  for (const key of cacheStore.keys()) {
    if (key.startsWith(prefix)) cacheStore.delete(key);
  }
}
