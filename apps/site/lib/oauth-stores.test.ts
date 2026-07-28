import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "./db";
import { makeSessionStore, makeStateStore, pruneOauthStates, resolveHandle } from "./oauth";

// @atproto/oauth-client-node's stateStore/sessionStore are async interfaces
// (so any backing store works, sync or not); better-sqlite3 is synchronous
// end to end, so makeStateStore/makeSessionStore just wrap prepared
// statements in already-resolved async methods. Exercised here directly
// against an in-memory db — no Next.js request context needed.
describe("oauth stores (SQLite-backed)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("state store", () => {
    it("returns undefined for a key that was never set", async () => {
      const store = makeStateStore(db);
      await expect(store.get("nonce-1")).resolves.toBeUndefined();
    });

    it("round-trips set -> get", async () => {
      const store = makeStateStore(db);
      const state = { dpopKey: { fake: "key" }, verifier: "abc", appState: undefined };
      await store.set("nonce-1", state as never);
      await expect(store.get("nonce-1")).resolves.toEqual(state);
    });

    it("set() overwrites an existing value for the same key", async () => {
      const store = makeStateStore(db);
      await store.set("nonce-1", { verifier: "first" } as never);
      await store.set("nonce-1", { verifier: "second" } as never);
      await expect(store.get("nonce-1")).resolves.toEqual({ verifier: "second" });
    });

    it("del() removes the row so a later get() returns undefined", async () => {
      const store = makeStateStore(db);
      await store.set("nonce-1", { verifier: "abc" } as never);
      await store.del("nonce-1");
      await expect(store.get("nonce-1")).resolves.toBeUndefined();
    });

    it("del() on a missing key is a no-op, not an error", async () => {
      const store = makeStateStore(db);
      await expect(store.del("never-existed")).resolves.toBeUndefined();
    });
  });

  describe("session store", () => {
    it("returns undefined for a did that was never set", async () => {
      const store = makeSessionStore(db);
      await expect(store.get("did:plc:nobody")).resolves.toBeUndefined();
    });

    it("round-trips set -> get", async () => {
      const store = makeSessionStore(db);
      const session = { tokenSet: { accessToken: "a" }, dpopJwk: { fake: "key" } };
      await store.set("did:plc:owner", session as never);
      await expect(store.get("did:plc:owner")).resolves.toEqual(session);
    });

    it("a second set() for the same key updates the stored value (upsert-then-update)", async () => {
      const store = makeSessionStore(db);
      await store.set("did:plc:owner", { tokenSet: { accessToken: "old" } } as never);
      await store.set("did:plc:owner", { tokenSet: { accessToken: "new" } } as never);
      await expect(store.get("did:plc:owner")).resolves.toEqual({ tokenSet: { accessToken: "new" } });
    });

    it("a second set() advances updated_at", async () => {
      const store = makeSessionStore(db);
      await store.set("did:plc:owner", { tokenSet: {} } as never);
      const firstRow = db.prepare("SELECT updated_at FROM oauth_sessions WHERE key = ?").get("did:plc:owner") as {
        updated_at: number;
      };
      vi.useFakeTimers();
      vi.advanceTimersByTime(10_000);
      await store.set("did:plc:owner", { tokenSet: {} } as never);
      vi.useRealTimers();
      const secondRow = db.prepare("SELECT updated_at FROM oauth_sessions WHERE key = ?").get("did:plc:owner") as {
        updated_at: number;
      };
      expect(secondRow.updated_at).toBeGreaterThan(firstRow.updated_at);
    });

    it("del() removes the row so a later get() returns undefined", async () => {
      const store = makeSessionStore(db);
      await store.set("did:plc:owner", { tokenSet: {} } as never);
      await store.del("did:plc:owner");
      await expect(store.get("did:plc:owner")).resolves.toBeUndefined();
    });
  });

  describe("pruneOauthStates", () => {
    it("deletes only rows older than olderThanMs, leaving fresh rows untouched", () => {
      const now = Date.now();
      db.prepare("INSERT INTO oauth_states (key, state, created_at) VALUES (?, ?, ?)").run(
        "stale",
        "{}",
        now - 60_000,
      );
      db.prepare("INSERT INTO oauth_states (key, state, created_at) VALUES (?, ?, ?)").run(
        "fresh",
        "{}",
        now - 1_000,
      );

      const deleted = pruneOauthStates(30_000, db);

      expect(deleted).toBe(1);
      const remaining = db
        .prepare("SELECT key FROM oauth_states ORDER BY key")
        .all()
        .map((r) => (r as { key: string }).key);
      expect(remaining).toEqual(["fresh"]);
    });

    it("returns 0 and deletes nothing when every row is fresh", () => {
      db.prepare("INSERT INTO oauth_states (key, state, created_at) VALUES (?, ?, ?)").run(
        "fresh",
        "{}",
        Date.now(),
      );
      expect(pruneOauthStates(60_000, db)).toBe(0);
    });
  });

  describe("resolveHandle", () => {
    // resolveHandle still builds the describeRepo URL from env.PDS_URL even
    // with a stubbed fetchJson (only the network call itself is stubbed),
    // so PDS_URL must be set for these tests regardless.
    beforeEach(() => {
      process.env.PDS_URL = "https://pds.example.com";
    });
    afterEach(() => {
      delete process.env.PDS_URL;
    });

    it("returns the handle on a successful describeRepo lookup", async () => {
      const fetchJson = vi.fn().mockResolvedValue({ handle: "owner.bsky.social" });
      await expect(resolveHandle("did:plc:owner", fetchJson)).resolves.toBe("owner.bsky.social");
    });

    it("returns undefined (never throws) when the lookup fails", async () => {
      const fetchJson = vi.fn().mockRejectedValue(new Error("network error"));
      await expect(resolveHandle("did:plc:owner", fetchJson)).resolves.toBeUndefined();
    });

    it("returns undefined when the response has no handle field", async () => {
      const fetchJson = vi.fn().mockResolvedValue({});
      await expect(resolveHandle("did:plc:owner", fetchJson)).resolves.toBeUndefined();
    });
  });
});
