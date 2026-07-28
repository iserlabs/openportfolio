import Database from "better-sqlite3";
import { env } from "./env";

/**
 * The framework app uses no Postgres (spec §9) -- a single SQLite file backs
 * everything the admin/OAuth layer needs. WAL mode lets a request reading the
 * db (e.g. an admin page render) not block a concurrent write (e.g. the OAuth
 * callback saving a session), which matters once this runs as a long-lived
 * Node server handling overlapping requests.
 *
 * Schema is created idempotently (`CREATE TABLE IF NOT EXISTS`) rather than
 * through a migration runner: this app has exactly one schema, versioned by
 * this file, not a migration history to replay.
 */
function initSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      key TEXT PRIMARY KEY,
      state TEXT,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS oauth_sessions (
      key TEXT PRIMARY KEY,
      session TEXT,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS blur (
      cid TEXT PRIMARY KEY,
      data_url TEXT
    );
  `);
}

/** Opens (and idempotently migrates) a SQLite db at `path`. `path` may be a real file, `:memory:`, or any better-sqlite3-accepted path -- tests use this directly to sidestep the `getDb()` singleton and its `env.SQLITE_PATH` dependency. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  initSchema(db);
  return db;
}

let instance: Database.Database | undefined;

/**
 * Process-wide singleton, opened lazily against `env.SQLITE_PATH` on first
 * use (never at import time, so `next build` still succeeds with zero env
 * vars set -- mirrors the laziness pattern in `env.ts`/`pds.ts`). All of
 * `oauth.ts`'s production stores share this one connection.
 */
export function getDb(): Database.Database {
  if (!instance) instance = openDb(env.SQLITE_PATH);
  return instance;
}
