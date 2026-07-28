import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { env } from "./env";
import { blobUrl, type FetchJson } from "./pds";

/**
 * Nightly self-scheduled CAR + blob backup (Task A10 -- the sovereignty
 * surface: "download my data" is always available via the export route, and
 * this is its unattended nightly counterpart, wired into `instrumentation.ts`
 * via `lib/backup-scheduler.ts`). Ported conceptually from nothing in
 * Luminance -- this app is single-owner and single-repo, so "back everything
 * up" collapses to "one CAR + every blob," rather than Luminance's
 * per-tenant fan-out.
 *
 * This module is *only* the CAR/blob half. The `oauth_states` janitor
 * (`pruneOauthStates`) used to live here but is deliberately decoupled (A10
 * review): it now runs unconditionally on every scheduler tick in
 * `lib/backup-scheduler.ts`, regardless of whether `runBackup` itself
 * no-ops -- an install that never configures `BACKUP_DIR` still needs its
 * abandoned OAuth flows garbage-collected.
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
}

export type BackupResult =
  | { skipped: true }
  | {
      skipped: false;
      ok: true;
      carPath: string;
      blobsWritten: number;
      blobsSkipped: number;
      blobsFailed: number;
    }
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
  // CARs can be large (a whole repo) -- a generous timeout vs. the 30s used
  // for JSON/blob calls below, since this covers the full body transfer,
  // not just headers (AbortSignal.timeout aborts the whole fetch, streaming
  // body included, once it elapses).
  return fetch(url, { signal: AbortSignal.timeout(120_000) });
}

/** Fetches the owner repo's CAR stream. Shared by the export route (pipes straight to the HTTP response) and `runBackup` (pipes straight to disk) -- one upstream call built one way, consumed two ways. */
export async function fetchRepoCar(fetchImpl: FetchCar = defaultFetchCar): Promise<Response> {
  return fetchImpl(repoCarUrl());
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
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

/**
 * Writes to `${filePath}.tmp` then atomically `rename`s onto `filePath` --
 * a reader (or a later backup run's `fileExists` skip-check) only ever sees
 * either "not there yet" or "fully written," never a truncated partial file
 * from an interrupted stream/write. On any failure, best-effort unlinks the
 * temp file before rethrowing (so a failed run doesn't leave `.tmp` litter
 * behind either).
 */
async function writeAtomically(filePath: string, write: (tmpPath: string) => Promise<void>): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  try {
    await write(tmpPath);
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Streams the upstream CAR response straight to `filePath` -- never buffers the whole repo in memory, regardless of repo size -- via a temp-then-rename atomic write. */
async function writeCarToFile(fetchCarImpl: FetchCar | undefined, filePath: string): Promise<void> {
  const res = await fetchRepoCar(fetchCarImpl);
  if (!res.ok || !res.body) throw new Error(`getRepo fetch failed: ${res.status}`);
  const body = res.body as NodeWebReadableStream<Uint8Array>;
  await writeAtomically(filePath, (tmpPath) => pipeline(Readable.fromWeb(body), createWriteStream(tmpPath)));
}

/**
 * Nightly CAR + blob backup, called every tick from
 * `lib/backup-scheduler.ts`. A no-op -- not a failure -- when
 * `env.BACKUP_DIR` isn't configured: the unset state is this app's
 * supported default, not a misconfiguration (mirrors `env.ts`'s own doc
 * comment on `BACKUP_DIR`).
 *
 * Exports the owner's whole repo as a fresh CAR snapshot
 * (`com.atproto.sync.getRepo`, streamed straight to
 * `BACKUP_DIR/car/<ISO-date>.car` -- one file per day, never overwritten
 * retroactively) and mirrors every blob (`com.atproto.sync.listBlobs`,
 * paged) into `BACKUP_DIR/blobs/<cid>`, skipping any cid already on disk
 * from a prior run. Blobs are content-addressed and immutable under a given
 * cid, so this step is incrementally cheap after the first run; the CAR
 * itself is a full snapshot every time (records mutate, so there's no
 * meaningful "diff" to skip). Both the CAR and each blob are written via a
 * temp-then-rename atomic write, so a run interrupted mid-transfer never
 * leaves a truncated file at the final path (which would otherwise look
 * "already backed up" to a later run's skip-if-exists check forever).
 *
 * A single failed blob (network hiccup, one bad cid) is logged and does not
 * abort the run -- the remaining blobs still get attempted, and the count
 * is folded into the returned `blobsFailed`. A failure in the CAR export or
 * in paging `listBlobs` itself, however, is a hard failure for the whole
 * tick (there's no partial CAR to keep, and no blob list to keep paging
 * without it): it's caught, logged, and folded into the returned result --
 * `runBackup` itself never throws, so a bad night's backup can't crash the
 * long-lived Node process or the scheduler loop driving it.
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
    let blobsFailed = 0;
    let cursor: string | undefined;

    for (let page = 0; page < LIST_BLOBS_MAX_PAGES; page++) {
      const params = new URLSearchParams({ did: env.OWNER_DID, limit: String(LIST_BLOBS_LIMIT) });
      if (cursor) params.set("cursor", cursor);
      const url = `${env.PDS_URL}/xrpc/com.atproto.sync.listBlobs?${params.toString()}`;
      const response = (await fetchJson(url)) as ListBlobsResponse;

      if (!response.cids || response.cids.length === 0) break; // stop regardless of any (stale/buggy) cursor still present

      for (const cid of response.cids) {
        try {
          // Defensive: a cid is about to become a bare filename under
          // blobsDir. It's sourced from the pinned, trusted PDS_URL host,
          // but this guard costs nothing and rules out a
          // malformed/adversarial cid (e.g. containing "../") ever
          // escaping blobsDir via path.join.
          if (path.basename(cid) !== cid) {
            throw new Error(`unsafe cid (path-traversal characters): ${cid}`);
          }

          const blobPath = path.join(blobsDir, cid);
          if (await fileExists(blobPath)) {
            blobsSkipped++;
            continue;
          }

          const bytes = await fetchBlob(cid);
          await writeAtomically(blobPath, (tmpPath) => writeFile(tmpPath, bytes));
          blobsWritten++;
        } catch (err) {
          blobsFailed++;
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[backup] blob ${cid} failed:`, message);
        }
      }

      cursor = response.cursor;
      if (!cursor) break;
    }

    return { skipped: false, ok: true, carPath, blobsWritten, blobsSkipped, blobsFailed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[backup] runBackup failed:", message);
    return { skipped: false, ok: false, error: message };
  }
}
