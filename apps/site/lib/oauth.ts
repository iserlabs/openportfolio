import { Agent } from "@atproto/api";
import {
  NodeOAuthClient,
  type NodeSavedSession,
  type NodeSavedSessionStore,
  type NodeSavedState,
  type NodeSavedStateStore,
} from "@atproto/oauth-client-node";
import type Database from "better-sqlite3";
import { getDb } from "./db";
import { env } from "./env";
import type { FetchJson } from "./pds";

/**
 * Build the client metadata document. Derived entirely from `env.PUBLIC_URL`
 * so the `/oauth/client-metadata.json` route and the OAuth client agree
 * byte-for-byte (the ATProto AS fetches `client_id` and validates the
 * returned metadata). `client_id` is, by ATProto convention, the URL of this
 * very document.
 *
 * Deviation from Luminance's `apps/web/lib/oauth.ts`: this is a *public*
 * client (`token_endpoint_auth_method: "none"`, no `keyset`/`jwks_uri`)
 * rather than a confidential `private_key_jwt` client. This app has exactly
 * one admin identity (`env.OWNER_DID`) rather than Luminance's many
 * registered photographers/viewers, so there's no fleet of long-lived
 * per-user refresh tokens whose blast radius a confidential client's signed
 * client-assertion is protecting -- the security-relevant guarantees this
 * app actually needs (DPoP-bound access tokens, PKCE, encrypted session
 * cookie) all still apply to a public client. This also matches the brief's
 * dependency list (`@atproto/oauth-client-node`, `@atproto/api`,
 * `iron-session`, `better-sqlite3` -- no `@atproto/jwk-jose`) and its file
 * list (no `jwks.json` route, no `OAUTH_JWK_1` env var). Upgrading to a
 * confidential client later is a localized change to this function plus a
 * new `jwks.json` route -- nothing in the store/session layers would move.
 */
function clientMetadata() {
  const base = env.PUBLIC_URL;
  return {
    client_id: `${base}/oauth/client-metadata.json`,
    client_name: "Open Portfolio Admin",
    client_uri: base,
    redirect_uris: [`${base}/oauth/callback`] as [string],
    grant_types: ["authorization_code", "refresh_token"] as ["authorization_code", "refresh_token"],
    response_types: ["code"] as ["code"],
    scope: "atproto",
    application_type: "web" as const,
    token_endpoint_auth_method: "none" as const,
    dpop_bound_access_tokens: true,
  };
}

/** Public client-metadata document, for the `/oauth/client-metadata.json` route. */
export function getClientMetadata() {
  return clientMetadata();
}

// ---- SQLite-backed OAuth stores --------------------------------------------
//
// @atproto/oauth-client-node's stateStore/sessionStore are async interfaces
// (so the library can be pointed at any backing store); better-sqlite3 is
// synchronous end-to-end, so every method here just wraps an already-run
// prepared statement in a `Promise`-returning function. `state`/`session`
// are opaque library-owned objects, serialized as JSON text (SQLite has no
// native JSON column type) -- this app never reads or writes their fields
// directly, only round-trips them for the OAuth client. Store shapes
// (`NodeSavedStateStore`/`NodeSavedSessionStore`) are the library's own
// exported types, not hand-rolled ones.

/**
 * `oauth_states` holds one short-lived row per in-flight authorize->callback
 * round trip (PKCE verifier + DPoP key). `INSERT OR REPLACE` keyed on the
 * nonce `key` covers both first-write and any re-write the library performs
 * mid-flow.
 */
export function makeStateStore(db: Database.Database): NodeSavedStateStore {
  const upsert = db.prepare("INSERT OR REPLACE INTO oauth_states (key, state, created_at) VALUES (?, ?, ?)");
  const select = db.prepare("SELECT state FROM oauth_states WHERE key = ?");
  const del = db.prepare("DELETE FROM oauth_states WHERE key = ?");

  return {
    async set(key, state) {
      upsert.run(key, JSON.stringify(state), Date.now());
    },
    async get(key) {
      const row = select.get(key) as { state: string } | undefined;
      return row ? (JSON.parse(row.state) as NodeSavedState) : undefined;
    },
    async del(key) {
      del.run(key);
    },
  };
}

/**
 * `oauth_sessions` holds the durable (refresh-token-bearing) session per
 * authenticated DID. `INSERT OR REPLACE` both creates the row on first sign-in
 * and updates it (including `updated_at`) on every later token refresh.
 */
export function makeSessionStore(db: Database.Database): NodeSavedSessionStore {
  const upsert = db.prepare("INSERT OR REPLACE INTO oauth_sessions (key, session, updated_at) VALUES (?, ?, ?)");
  const select = db.prepare("SELECT session FROM oauth_sessions WHERE key = ?");
  const del = db.prepare("DELETE FROM oauth_sessions WHERE key = ?");

  return {
    async set(key, session) {
      upsert.run(key, JSON.stringify(session), Date.now());
    },
    async get(key) {
      const row = select.get(key) as { session: string } | undefined;
      return row ? (JSON.parse(row.session) as NodeSavedSession) : undefined;
    },
    async del(key) {
      del.run(key);
    },
  };
}

/**
 * Deletes `oauth_states` rows whose `created_at` is older than `olderThanMs`
 * ago. These rows are only ever meant to live for the few seconds/minutes of
 * a single authorize->callback round trip; anything older is an abandoned
 * flow (the visitor never completed sign-in) and safe to garbage-collect.
 * Returns the number of rows deleted. `db` defaults to the process singleton
 * (production call sites); tests inject their own in-memory db.
 */
export function pruneOauthStates(olderThanMs: number, db: Database.Database = getDb()): number {
  const cutoff = Date.now() - olderThanMs;
  const result = db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(cutoff);
  return result.changes;
}

/**
 * Construct the OAuth client. Built lazily (never at module load) so the app
 * builds with zero env vars -- `env.*` is only read when a real OAuth
 * request comes in. State/session are persisted in SQLite (via the stores
 * above) so the flow survives across the stateless serverless requests of
 * the authorize -> callback round trip.
 */
export async function getOAuthClient(): Promise<NodeOAuthClient> {
  const db = getDb();
  return new NodeOAuthClient({
    clientMetadata: clientMetadata(),
    stateStore: makeStateStore(db),
    sessionStore: makeSessionStore(db),
  });
}

/**
 * Restores the owner's persisted OAuth session and wraps it in an `Agent`,
 * for server actions that need to write to the owner's own repo.
 * `client.restore(did)` returns an `OAuthSession` exposing a `did` getter and
 * a `fetchHandler` -- exactly the `SessionManager` shape `Agent`'s
 * constructor accepts directly (`new Agent(session)`), same as Luminance's
 * `restoreAgent` in `apps/web/lib/interactions.ts`.
 */
export async function restoreAgent(did: string): Promise<Agent> {
  const client = await getOAuthClient();
  const session = await client.restore(did);
  return new Agent(session);
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`describeRepo fetch ${url}: ${res.status}`);
  return res.json();
}

/**
 * Best-effort handle resolution for a signed-in DID, via
 * `com.atproto.repo.describeRepo` against the pinned `env.PDS_URL`. Unlike
 * Luminance's multi-tenant `resolveHandle` (which resolves an arbitrary
 * DID's *own* PDS via its DID document, since Luminance hosts many
 * photographers each on their own PDS), this app is pinned to a single repo
 * -- there is exactly one PDS to ask. This lookup only ever succeeds for
 * `env.OWNER_DID`; a non-owner visitor completing OAuth with their own
 * unrelated handle (anyone can start the login flow -- only `env.OWNER_DID`
 * unlocks admin via `requireOwner()`) will simply get a failed lookup here,
 * which is fine: every call site treats failure as "leave handle unset,"
 * never as fatal.
 */
export async function resolveHandle(
  did: string,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<string | undefined> {
  try {
    const url = `${env.PDS_URL}/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(did)}`;
    const data = (await fetchJson(url)) as { handle?: string };
    return data.handle;
  } catch {
    return undefined;
  }
}
