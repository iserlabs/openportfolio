import { createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { env } from "./env";
import { blobUrl, type FetchJson } from "./pds";
import { pruneOauthStates as defaultPruneOauthStates } from "./oauth";

/**
 * Nightly self-scheduled backup + CAR export (Task A10 -- the sovereignty
 * surface: "download my data" is always available via the export route, and
 * this is its unattended nightly counterpart, wired into `instrumentation.ts`).
 * Ported conceptually from nothing in Luminance -- this app is single-owner
 * and single-repo, so "back everything up" collapses to "one CAR + every
 * blob," rather than Luminance's per-tenant fan-out.
 */

/** Fetches the CAR stream for `com.atproto.sync.getRepo`. Returns the raw `Response` (never parsed) so both this module and the export route can pipe `.body` straight through without ever buffering the whole repo in memory. */
export type FetchCar = (url: string) => Promise<Response>;

/** Fetches one blob's raw bytes for `com.atproto.sync.getBlob`. */
export type FetchBlobBytes = (cid: string) => Promise<Buffer>;

export interface BackupDeps {
  fetchCar?: FetchCar;
  fetchJson?: FetchJson;
  fetchBlob?: FetchBlobBytes;
  /** Clock override for the ISO-date CAR filename -- tests pin this instead of racing real time. */
  now?: () => Date;
  pruneOauthStates?: (olderThanMs: number) => number;
}

export type BackupResult =
  | { skipped: true }
  | { skipped: false; ok: true; carPath: string; blobsWritten: number; blobsSkipped: number }
  | { skipped: false; ok: false; error: string };

// Mirrors lib/pds.ts's listAllRecords bounding rationale: a hard ceiling on
// pages so a PDS returning a cursor forever can't spin this loop forever.
const LIST_BLOBS_LIMIT = 500;
const LIST_BLOBS_HARD_CAP = 200_000;
const LIST_BLOBS_MAX_PAGES = LIST_BLOBS_HARD_CAP / LIST_BLOBS_LIMIT;

interface ListBlobsResponse {
  cids: string[];
  cursor?: string;
}

/** Builds the `com.atproto.sync.getRepo` URL for the pinned owner repo against the pinned `env.PDS_URL` host -- an unauthenticated sync endpoint, per spec. */
export function repoCarUrl(): string {
  return `${env.PDS_URL}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(env.OWNER_DID)}`;
}

async function defaultFetchCar(url: string): Promise<Response> {
  return fetch(url);
}

/** Fetches the owner repo's CAR stream. Shared by the export route (pipes straight to the HTTP response) and `runBackup` (pipes straight to disk) -- one upstream call built one way, consumed two ways. */
export async function fetchRepoCar(fetchImpl: FetchCar = defaultFetchCar): Promise<Response> {
  return fetchImpl(repoCarUrl());
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`listBlobs fetch ${url}: ${res.status}`);
  return res.json();
}

async function defaultFetchBlob(cid: string): Promise<Buffer> {
  // blobUrl() is pinned to env.PDS_URL -- unauthenticated sync.getBlob, same
  // pinned-host guarantee as lib/image-proxy.ts's defaultFetchBlob.
  const res = await fetch(blobUrl(cid), { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`getBlob ${cid}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Streams the upstream CAR response straight to `filePath` -- never buffers the whole repo in memory, regardless of repo size. */
async function writeCarToFile(fetchCarImpl: FetchCar | undefined, filePath: string): Promise<void> {
  const res = await fetchRepoCar(fetchCarImpl);
  if (!res.ok || !res.body) throw new Error(`getRepo fetch failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as NodeWebReadableStream<Uint8Array>), createWriteStream(filePath));
}

/**
 * Nightly self-scheduled backup, called from `instrumentation.ts`'s 24h
 * `setInterval`. A no-op -- not a failure -- when `env.BACKUP_DIR` isn't
 * configured: the unset state is this app's supported default, not a
 * misconfiguration (mirrors `env.ts`'s own doc comment on `BACKUP_DIR`).
 *
 * Two chores per tick:
 *  1. Export the owner's whole repo as a fresh CAR snapshot
 *     (`com.atproto.sync.getRepo`, streamed straight to
 *     `BACKUP_DIR/car/<ISO-date>.car` -- one file per day, never overwritten
 *     retroactively) and mirror every blob (`com.atproto.sync.listBlobs`,
 *     paged) into `BACKUP_DIR/blobs/<cid>`, skipping any cid already on disk
 *     from a prior run. Blobs are content-addressed and immutable under a
 *     given cid, so this step is incrementally cheap after the first run;
 *     the CAR itself is a full snapshot every time (records mutate, so
 *     there's no meaningful "diff" to skip).
 *  2. Prune stale `oauth_states` rows (`pruneOauthStates`, carried over from
 *     Task A5's review) -- the janitor pattern: one scheduler tick, two
 *     chores, rather than a second timer just for OAuth-state TTL.
 *     Deliberately only runs on this tick's success path (see the addendum):
 *     it piggybacks on the backup tick rather than standing alone, so it
 *     only fires when there was in fact a tick to piggyback on.
 *
 * Never throws: any failure (network, disk, PDS error) is logged and folded
 * into the returned result, so a bad night's backup can't crash the
 * long-lived Node process or the `setInterval` loop driving it.
 */
export async function runBackup(deps: BackupDeps = {}): Promise<BackupResult> {
  const backupDir = env.BACKUP_DIR;
  if (!backupDir) return { skipped: true };

  try {
    const now = deps.now?.() ?? new Date();
    const isoDate = now.toISOString().slice(0, 10);

    const carDir = path.join(backupDir, "car");
    await mkdir(carDir, { recursive: true });
    const carPath = path.join(carDir, `${isoDate}.car`);
    await writeCarToFile(deps.fetchCar, carPath);

    const blobsDir = path.join(backupDir, "blobs");
    await mkdir(blobsDir, { recursive: true });
    const fetchJson = deps.fetchJson ?? defaultFetchJson;
    const fetchBlob = deps.fetchBlob ?? defaultFetchBlob;

    let blobsWritten = 0;
    let blobsSkipped = 0;
    let cursor: string | undefined;

    for (let page = 0; page < LIST_BLOBS_MAX_PAGES; page++) {
      const params = new URLSearchParams({ did: env.OWNER_DID, limit: String(LIST_BLOBS_LIMIT) });
      if (cursor) params.set("cursor", cursor);
      const url = `${env.PDS_URL}/xrpc/com.atproto.sync.listBlobs?${params.toString()}`;
      const response = (await fetchJson(url)) as ListBlobsResponse;

      if (!response.cids || response.cids.length === 0) break; // stop regardless of any (stale/buggy) cursor still present

      for (const cid of response.cids) {
        // Defensive: a cid is about to become a bare filename under
        // blobsDir. It's sourced from the pinned, trusted PDS_URL host, but
        // this guard costs nothing and rules out a malformed/adversarial
        // cid (e.g. containing "../") ever escaping blobsDir via path.join.
        if (path.basename(cid) !== cid) {
          console.error(`[backup] skipping blob with unsafe cid: ${cid}`);
          continue;
        }
        const blobPath = path.join(blobsDir, cid);
        if (await fileExists(blobPath)) {
          blobsSkipped++;
          continue;
        }
        const bytes = await fetchBlob(cid);
        await writeFile(blobPath, bytes);
        blobsWritten++;
      }

      cursor = response.cursor;
      if (!cursor) break;
    }

    const prune = deps.pruneOauthStates ?? defaultPruneOauthStates;
    prune(60 * 60 * 1000);

    return { skipped: false, ok: true, carPath, blobsWritten, blobsSkipped };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[backup] runBackup failed:", message);
    return { skipped: false, ok: false, error: message };
  }
}
