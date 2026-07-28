import type Database from "better-sqlite3";
import { exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "./db";
import {
  getClientMetadata,
  getOAuthClient,
  getPublicJwks,
  makeSessionStore,
  makeStateStore,
  pruneOauthStates,
  resolveHandle,
} from "./oauth";

// getOAuthClient()/getPublicJwks() need a real ES256 keypair to build the
// confidential client's `keyset` (see clientMetadata()'s
// token_endpoint_auth_method: "private_key_jwt"). Generated fresh per test
// via jose's own generateKeyPair/exportJWK rather than a hardcoded fixture
// JWK string, so these tests can't bit-rot against a key some future jose
// version considers invalid, and never risk a real signing key leaking into
// the repo. `kid` + `alg` are required in the JSON blob itself (not passed
// separately) -- `@atproto/oauth-client` rejects a private_key_jwt keyset
// with no `kid`, and this is also exactly the shape `setup.sh` (Task A11)
// produces, matching Luminance's own OAUTH_JWK_1 generation one-liner in
// `docs/runbooks/launch-alpha.md`.
async function ephemeralOauthJwk(): Promise<string> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  return JSON.stringify({ ...jwk, alg: "ES256", kid: `test-${crypto.randomUUID()}` });
}

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

describe("clientMetadata", () => {
  beforeEach(() => {
    process.env.PUBLIC_URL = "https://portfolio.example.com";
  });
  afterEach(() => {
    delete process.env.PUBLIC_URL;
  });

  it("declares a confidential private_key_jwt client with a jwks_uri", () => {
    const metadata = getClientMetadata();
    expect(metadata.token_endpoint_auth_method).toBe("private_key_jwt");
    expect(metadata.token_endpoint_auth_signing_alg).toBe("ES256");
    expect(metadata.jwks_uri).toBe("https://portfolio.example.com/oauth/jwks.json");
    expect(metadata.dpop_bound_access_tokens).toBe(true);
    expect(metadata.client_id).toBe("https://portfolio.example.com/oauth/client-metadata.json");
    // "transition:generic" (Task A13 finding): the bare "atproto" scope only
    // establishes identity under @atproto/oauth-scopes' granular permission
    // model -- a session without it gets ScopeMissingError on the very first
    // uploadBlob/createRecord call. See clientMetadata()'s own doc comment.
    expect(metadata.scope).toBe("atproto transition:generic");
  });
});

describe("confidential client (real ES256 keyset)", () => {
  // getOAuthClient()/getPublicJwks() both need env.OAUTH_JWK to build the
  // keyset -- generated fresh per test (see ephemeralOauthJwk above), never
  // a fixture string.
  beforeEach(async () => {
    process.env.PUBLIC_URL = "https://portfolio.example.com";
    process.env.SQLITE_PATH = ":memory:";
    process.env.OAUTH_JWK = await ephemeralOauthJwk();
  });
  afterEach(() => {
    delete process.env.PUBLIC_URL;
    delete process.env.SQLITE_PATH;
    delete process.env.OAUTH_JWK;
  });

  it("getOAuthClient() builds a NodeOAuthClient from the configured OAUTH_JWK", async () => {
    const client = await getOAuthClient();
    expect(typeof client.authorize).toBe("function");
    expect(typeof client.callback).toBe("function");
    expect(typeof client.restore).toBe("function");
  });

  it("getPublicJwks() exposes only the public half of the configured key", async () => {
    const jwks = await getPublicJwks();
    expect(jwks.keys).toHaveLength(1);
    const [publicJwk] = jwks.keys as Array<Record<string, unknown>>;
    expect(publicJwk.kty).toBe("EC");
    expect(publicJwk.crv).toBe("P-256");
    // The private "d" component must never be serialized to this public route.
    expect(publicJwk.d).toBeUndefined();
  });

  // Task A13's dev-only escape hatch: when OAUTH_PLC_URL is set, getOAuthClient()
  // still builds a working client (just wired at a local dev-env network instead
  // of the real internet) rather than throwing.
  it("getOAuthClient() still builds when OAUTH_PLC_URL is set (dev/E2E identity-resolution override)", async () => {
    process.env.PDS_URL = "http://localhost:9999";
    process.env.OAUTH_PLC_URL = "http://localhost:9998";
    try {
      const client = await getOAuthClient();
      expect(typeof client.authorize).toBe("function");
    } finally {
      delete process.env.PDS_URL;
      delete process.env.OAUTH_PLC_URL;
    }
  });
});
