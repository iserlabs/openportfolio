import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getDb() is a lazy module-level singleton keyed on env.SQLITE_PATH (mirrors
// the lazy-env pattern in env.ts/pds.ts: nothing touches the filesystem at
// import time). Each test resets the module registry so the singleton is
// rebuilt against a fresh temp-file path — otherwise the first test to call
// getDb() would pin every later test to its db file.
describe("db", () => {
  let tmpPath: string;

  beforeEach(() => {
    vi.resetModules();
    tmpPath = path.join(os.tmpdir(), `open-portfolio-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.SQLITE_PATH = tmpPath;
  });

  afterEach(() => {
    delete process.env.SQLITE_PATH;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        fs.unlinkSync(tmpPath + suffix);
      } catch {
        // fine if it was never created
      }
    }
  });

  it("creates the oauth_states, oauth_sessions, and blur tables idempotently", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(["oauth_states", "oauth_sessions", "blur"]));
  });

  it("returns the same singleton instance across repeated calls", async () => {
    const { getDb } = await import("./db.js");
    expect(getDb()).toBe(getDb());
  });

  it("opens the configured SQLITE_PATH, not some other file", async () => {
    const { getDb } = await import("./db.js");
    getDb();
    expect(fs.existsSync(tmpPath)).toBe(true);
  });

  it("openDb() can reopen the same file without error (CREATE TABLE IF NOT EXISTS)", async () => {
    const { openDb } = await import("./db.js");
    const first = openDb(tmpPath);
    first.close();
    expect(() => {
      const second = openDb(tmpPath);
      second.close();
    }).not.toThrow();
  });

  it("openDb() works against an in-memory database", async () => {
    const { openDb } = await import("./db.js");
    const db = openDb(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(["oauth_states", "oauth_sessions", "blur"]));
    db.close();
  });
});
