import type Database from "better-sqlite3";
import { getDb } from "./db";

/**
 * Reads the `~16px` blur-up placeholder data URIs `lib/image-proxy.ts` has
 * populated so far for the given photograph blob cids. Blur values live in
 * SQLite (server-side only, spec §9's "no Postgres" constraint) -- they
 * never travel through `getPortfolio()`'s PDS-backed read model, so public
 * pages call this directly, once per render, with every cid they're about
 * to show, then thread the result into `PhotoGrid`/`PhotoCard`'s
 * `blurDataUrl` props. A cid the proxy hasn't served yet (no row) simply
 * gets no placeholder -- never an error.
 */
export function blurDataUrls(cids: string[], db: Database.Database = getDb()): Map<string, string> {
  const map = new Map<string, string>();
  if (cids.length === 0) return map;

  const placeholders = cids.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT cid, data_url FROM blur WHERE cid IN (${placeholders})`)
    .all(...cids) as { cid: string; data_url: string }[];
  for (const row of rows) map.set(row.cid, row.data_url);
  return map;
}
