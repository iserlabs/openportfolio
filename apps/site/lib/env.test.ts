import { afterEach, describe, expect, it } from "vitest";

// Every getter is exercised here individually — a typo in one `req("...")`
// key would otherwise pass silently as long as some *other* test happened to
// set that particular env var (see e.g. pds.test.ts, which only ever sets
// PDS_URL/OWNER_DID).
const REQUIRED_KEYS = ["PDS_URL", "OWNER_DID", "PUBLIC_URL", "SESSION_SECRET", "SQLITE_PATH"] as const;

describe("env", () => {
  afterEach(() => {
    for (const k of REQUIRED_KEYS) delete process.env[k];
    delete process.env.BACKUP_DIR;
  });

  it("does not read process.env at import time (build must succeed with zero env vars set)", async () => {
    await expect(import("./env.js")).resolves.toBeDefined();
  });

  it.each(REQUIRED_KEYS)("%s: throws a clear message when accessed but unset", async (key) => {
    const { env } = await import("./env.js");
    delete process.env[key];
    expect(() => env[key]).toThrow(new RegExp(`missing env ${key}`));
  });

  it.each(REQUIRED_KEYS)("%s: returns the value once set", async (key) => {
    const { env } = await import("./env.js");
    process.env[key] = `test-value-${key}`;
    expect(env[key]).toBe(`test-value-${key}`);
  });

  it("BACKUP_DIR: returns undefined without throwing when unset (backups are optional, not required)", async () => {
    const { env } = await import("./env.js");
    delete process.env.BACKUP_DIR;
    expect(env.BACKUP_DIR).toBeUndefined();
  });

  it("BACKUP_DIR: returns the value once set", async () => {
    const { env } = await import("./env.js");
    process.env.BACKUP_DIR = "/var/backups/open-portfolio";
    expect(env.BACKUP_DIR).toBe("/var/backups/open-portfolio");
  });
});
