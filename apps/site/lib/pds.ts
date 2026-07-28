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

/**
 * Signals "record does not exist" distinctly from other fetch failures, so
 * `getRecord` can turn it into `null` instead of throwing. ATProto PDSes are
 * inconsistent about the wire shape here — some return a plain HTTP 404,
 * others a 400 with `{ error: "RecordNotFound" }` — `defaultFetchJson` below
 * detects both and normalizes to this error; a stubbed `fetchJson` in tests
 * can throw it directly.
 */
export class PdsRecordNotFoundError extends Error {
  constructor(url: string) {
    super(`pds record not found: ${url}`);
    this.name = "PdsRecordNotFoundError";
  }
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (res.status === 404) throw new PdsRecordNotFoundError(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    if (body?.error === "RecordNotFound") throw new PdsRecordNotFoundError(url);
    throw new Error(`pds fetch ${url}: ${res.status}`);
  }
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
const LIST_RECORDS_MAX_PAGES = LIST_RECORDS_HARD_CAP / LIST_RECORDS_LIMIT; // 50 — bounds requests even if records never accumulate to the cap

/**
 * Pages `com.atproto.repo.listRecords` for `collection` in the pinned repo
 * (`env.OWNER_DID`) at `limit=100`, joining pages until the response omits
 * `cursor`. Termination is double-bounded, not just record-count-bounded:
 * (1) an empty `records` page always stops the walk immediately, even if the
 * response still carries a (stale/buggy) truthy `cursor` — otherwise a PDS
 * returning `{ records: [], cursor: "..." }` forever would hang this
 * function forever, since record count alone would never trip the cap; (2)
 * a hard ceiling of `LIST_RECORDS_MAX_PAGES` (5000/100) requests, so even a
 * PDS that always returns exactly one record per page alongside a cursor
 * can't keep this walking past 5000 records' worth of round trips.
 */
export async function listAllRecords<T>(
  collection: string,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<RecordEnvelope<T>[]> {
  const out: RecordEnvelope<T>[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < LIST_RECORDS_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      repo: env.OWNER_DID,
      collection,
      limit: String(LIST_RECORDS_LIMIT),
    });
    if (cursor) params.set("cursor", cursor);

    const url = `${env.PDS_URL}/xrpc/com.atproto.repo.listRecords?${params.toString()}`;
    const response = (await fetchJson(url)) as ListRecordsResponse;

    if (response.records.length === 0) break; // nothing more to consume, regardless of any cursor still present

    for (const r of response.records) {
      out.push({ uri: r.uri, cid: r.cid, value: r.value as T });
      if (out.length >= LIST_RECORDS_HARD_CAP) return out;
    }

    cursor = response.cursor;
    if (!cursor) break;
  }

  return out;
}

/**
 * Fetches a single record via `com.atproto.repo.getRecord` from the pinned
 * repo. Returns `null` — rather than throwing — when the record does not
 * exist (e.g. the singleton `social.opencontent.site` record at rkey `self`
 * before the owner has ever published one); any other fetch failure still
 * propagates as a thrown error.
 */
export async function getRecord<T>(
  collection: string,
  rkey: string,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<RecordEnvelope<T> | null> {
  const params = new URLSearchParams({ repo: env.OWNER_DID, collection, rkey });
  const url = `${env.PDS_URL}/xrpc/com.atproto.repo.getRecord?${params.toString()}`;
  try {
    const record = (await fetchJson(url)) as GetRecordResponse;
    return { uri: record.uri, cid: record.cid, value: record.value as T };
  } catch (err) {
    if (err instanceof PdsRecordNotFoundError) return null;
    throw err;
  }
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

/**
 * Returns the cached value for `key` if still within `ttlMs`; otherwise calls
 * `fn`, caches, and returns the fresh value.
 *
 * Known tradeoff: no in-flight de-duplication. Two concurrent misses on the
 * same `key` (e.g. two simultaneous cold requests for the same page) will
 * both call `fn` and both write the result, rather than the second awaiting
 * the first's in-progress call. Acceptable for this site's read volume; if
 * that ever changes, the fix is a `Map<string, Promise<unknown>>` of
 * in-flight calls consulted before invoking `fn`.
 */
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
