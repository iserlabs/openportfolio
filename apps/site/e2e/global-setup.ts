import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FullConfig } from "@playwright/test";
import { TestNetworkNoAppView } from "@atproto/dev-env";
import { exiftool } from "exiftool-vendored";
import getPort from "get-port";
import { exportJWK, generateKeyPair } from "jose";
import selfsigned from "selfsigned";
import sharp from "sharp";
import { Agent as UndiciAgent, interceptors, setGlobalDispatcher } from "undici";

// ── Task A13: real-browser author-loop E2E, globalSetup ────────────────────
//
// Boots a real local ATProto network (`@atproto/dev-env`'s
// `TestNetworkNoAppView` -- same SQLite-native, no-Docker boot this repo's
// `integration/portfolio.dev-env.test.ts` already uses for Task A12), mints
// an owner account plus a second, unrelated account, builds and starts a
// REAL production instance of this app pointed at that network, and fronts
// it with a small local HTTPS proxy so the whole thing is reachable at a
// real (if fake) hostname over real TLS. `author-loop.spec.ts` then drives
// scripted OAuth against dev-env's own real `@atproto/oauth-provider`
// sign-in form through a real Chromium instance -- no mocks anywhere in the
// chain from browser click to PDS record.
//
// ── Why this isn't "webServer starts `next dev`, globalSetup boots the
// network" (the naive shape) ────────────────────────────────────────────────
//
// Playwright's own task ordering starts a configured `webServer` (if any)
// BEFORE `globalSetup` runs (its plugin-setup task is queued ahead of the
// global-setup task -- see `packages/playwright/src/runner/tasks.ts`). A
// `webServer.env` is also a plain object evaluated once, at config-load
// time. Both facts together mean a `webServer`-managed process can never
// carry env values (a dev-env PDS's randomly-chosen port; an owner DID that
// doesn't exist until an account is created against that PDS) that are only
// known *after* globalSetup runs -- by the time globalSetup produces them,
// the webServer child's env was already snapshotted at spawn. So this file
// owns the whole server lifecycle itself (boot network -> resolve real env
// -> spawn the app -> wait ready), returning a teardown closure (Playwright
// runs a function returned from `globalSetup` as `globalTeardown` --
// avoids a second file needing to share live handles like the network or
// child-process objects across a process boundary).
//
// ── Why the app runs behind a self-signed HTTPS proxy on a fake hostname
// (not plain `http://localhost:PORT`) ───────────────────────────────────────
//
// This app's OAuth client (`lib/oauth.ts`) declares `application_type:
// "web"` with a confidential `private_key_jwt` credential -- deliberately
// matching Luminance's own production client shape, not some E2E-only
// downgrade. `@atproto/oauth-provider`'s own `ClientManager` (server-side,
// unmodified, un-mockable) validates that client's metadata unconditionally:
// a "web" client's `redirect_uris` may not use `localhost`/`127.0.0.1` at
// all (that carve-out is native/public-client only) and must use `https:`
// with a hostname whose TLD isn't one of the reserved test-only ones
// (`test`/`local`/`localhost`/`invalid`/`example`, per `isLocalHostname` in
// `@atproto/oauth-types`). So a "web" confidential client, talking to a real
// unmodified oauth-provider, can only ever authorize from a real HTTPS
// origin with a non-reserved hostname -- there is no local/HTTP escape
// hatch for this client shape, by design. `FAKE_HOST` below is exactly such
// a hostname; nothing resolves it in real DNS, so:
//   - Chromium is launched (playwright.config.ts) with
//     `--host-resolver-rules=MAP <FAKE_HOST> 127.0.0.1` so browser
//     navigation reaches our local proxy.
//   - This process's own outbound fetches (specifically: the in-process
//     dev-env PDS's own server-side fetch of our `/oauth/client-metadata
//     .json` and `/oauth/jwks.json`, part of it validating our client) are
//     redirected the same way via an undici DNS interceptor below --
//     Chromium's flag has no effect on this Node process's own fetches.
// A self-signed cert (SAN = `FAKE_HOST`) terminates TLS at the proxy;
// Chromium is launched with `ignoreHTTPSErrors` and this process disables
// certificate verification on its own patched dispatcher (`rejectUnauthorized:
// false`) -- both scoped to this throwaway local harness only, never to how
// the app itself talks to the PDS in production.
//
// ── Why `next build` + `next start` (not `next dev`) ────────────────────────
//
// Confirmed empirically while building this harness: `next dev
// --experimental-https` (even against `localhost`, unrelated to the
// fake-hostname setup above) fails its Turbopack HMR websocket handshake
// when served over a self-signed cert (`net::ERR_INVALID_HTTP_RESPONSE`),
// and the dev client's reconnect/overlay behavior around that failure was
// observed to silently reset an already-hydrated page -- `/admin/upload`'s
// `"use client"` dropzone never wired up its `onChange`/`onClick` handlers
// as a result (`setInputFiles` on the file input landed on a dead listener).
// `next start` has no HMR client at all, so it isn't exposed to this at
// all -- and it's arguably the more honest thing to drive here anyway: this
// suite is asserting the real deployed author loop, not a dev-only surface.
// `next start` also has no `--experimental-https` flag (dev-only), which is
// the other half of why this file runs its own TLS-terminating proxy in
// front of a plain-HTTP `next start` rather than asking Next to serve HTTPS
// itself.
//
// ── Why `getOAuthClient()`/`clientMetadata()` changed (lib/oauth.ts,
// lib/env.ts) as part of this task ──────────────────────────────────────────
//
// Building this harness surfaced two real, previously-unexercised bugs in
// the app's own OAuth-authenticated write path (every earlier test drives
// `publishPhotographCore` etc. with a plain session-based `agent` -- never a
// real OAuth-issued, DPoP-bound, scope-checked one, so neither was ever
// exercised before this suite): `getOAuthClient()` rebuilt a fresh
// `NodeOAuthClient` (and so a fresh, empty in-memory DPoP-nonce cache) on
// every call, and the client's declared `scope` ("atproto" only) does not
// satisfy `@atproto/oauth-scopes`' granular permission model for a blob
// upload or record write. Both are fixed in `lib/oauth.ts` itself (a
// config-keyed client cache; `scope: "atproto transition:generic"`), not
// special-cased for this harness -- see that file's own doc comments.

export const FAKE_HOST = "openportfolio-e2e.internal";

// dev-env's serviceHandleDomains include ".test" -- handles must end in one.
// "owner.test"/"visitor.test"/"guest.test" are all rejected by the dev-env
// PDS as reserved handles (see @atproto/pds's handle/reserved.js); confirmed
// "photographer.test" (matching Task A12's own fixture) and "nonowner.test"
// are not on that list.
const OWNER_HANDLE = "photographer.test";
const OWNER_PASSWORD = "password";
const NON_OWNER_HANDLE = "nonowner.test";
const NON_OWNER_PASSWORD = "password2";

const FIXTURE_TITLE = "Ridge at Dawn (E2E fixture)";
const FIXTURE_WIDTH = 800;
const FIXTURE_HEIGHT = 500;

// Playwright transpiles this config/globalSetup as CommonJS by default (no
// "type": "module" in apps/site/package.json), so `__dirname` is what's
// actually available here -- `import.meta.dirname` throws a hard syntax
// error under that transpilation.
const SITE_DIR = path.resolve(__dirname, "..");
const NEXT_BIN = path.join(SITE_DIR, "node_modules", ".bin", "next");

/** Shape written to `E2E_CONFIG_PATH`; read back by author-loop.spec.ts. */
export interface E2EConfig {
  baseUrl: string;
  fakeHost: string;
  ownerHandle: string;
  ownerPassword: string;
  ownerDid: string;
  nonOwnerHandle: string;
  nonOwnerPassword: string;
  fixturePath: string;
  fixtureTitle: string;
}

/** Same ephemeral-JWK shape `lib/oauth-stores.test.ts` generates for tests -- a real ES256 keypair, never a fixture string, never written to the repo. */
async function ephemeralOauthJwk(): Promise<string> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  return JSON.stringify({ ...jwk, alg: "ES256", kid: `e2e-${randomUUID()}` });
}

/** A real JPEG (sharp-generated) carrying an embedded IPTC/XMP Title, mirroring `lib/photo-metadata.test.ts`'s fixture pattern -- generated at run time, never a committed binary, so the prefill this suite asserts on is exercising the real exiftool/exifr read path, not a stub. */
async function writeFixtureJpeg(destPath: string): Promise<void> {
  const base = await sharp({
    create: { width: FIXTURE_WIDTH, height: FIXTURE_HEIGHT, channels: 3, background: "#4a6" },
  })
    .jpeg()
    .toBuffer();
  writeFileSync(destPath, base);
  await exiftool.write(destPath, { Title: FIXTURE_TITLE }, { writeArgs: ["-overwrite_original"] });
}

/** Points this process's own outbound fetches for `FAKE_HOST` at 127.0.0.1 (no real DNS involved), and disables TLS verification for the self-signed proxy cert -- see this file's header comment. Every other hostname falls through to real DNS, so this doesn't disturb anything else this process fetches (e.g. dev-env's PLC-directory-style internal calls). */
function installFakeHostDispatcher(): void {
  const { dns } = interceptors;
  setGlobalDispatcher(
    new UndiciAgent({ connect: { rejectUnauthorized: false } }).compose([
      dns({
        lookup: (origin, _opts, cb) => {
          if (origin.hostname === FAKE_HOST) {
            cb(null, [{ address: "127.0.0.1", family: 4, ttl: 10 }]);
            return;
          }
          import("node:dns").then(({ default: nodeDns }) =>
            nodeDns.lookup(origin.hostname, { all: true, verbatim: true }, (err, addresses) => {
              if (err) {
                cb(err, []);
                return;
              }
              cb(
                null,
                addresses.map((a) => ({ address: a.address, family: a.family as 4 | 6, ttl: 10 })),
              );
            }),
          );
        },
      }),
    ]),
  );
}

/** Polls `url` (via this process's own, already-patched fetch) until it responds, or throws after `timeoutMs`. */
async function waitUntilReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url} to become ready: ${String(lastErr)}`);
}

/** Spawns a child, tagging its stdout/stderr with `label` so a developer running this by hand can see what's happening. Returns the child immediately (does not wait for it to be ready). */
function spawnTagged(label: string, command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, { cwd: SITE_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[${label}] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${label}!] ${d}`));
  return child;
}

/** SIGTERMs `child` and, on POSIX, its whole process group (Next spawns its own worker subprocesses -- killing only the direct child can leave them running). Resolves once the child has actually exited (or after a grace period). */
async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    // already gone
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (child.exitCode === null && !child.killed) {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  installFakeHostDispatcher();

  const workDir = await mkdtemp(path.join(tmpdir(), "op-e2e-"));

  // Build and boot the network concurrently -- the build needs no real env
  // values (env.ts's getters are lazy; every app route is server-rendered
  // on demand, never statically prerendered against a real PDS/owner), so
  // it doesn't actually depend on the network existing first.
  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PDS_URL: "http://localhost:1",
    OWNER_DID: "did:plc:placeholder0000000000",
    PUBLIC_URL: "https://placeholder.invalid",
    SESSION_SECRET: "0".repeat(32),
    SQLITE_PATH: path.join(workDir, "build-placeholder.db"),
    OAUTH_JWK: "{}",
  };
  const buildPromise = new Promise<void>((resolve, reject) => {
    const build = spawnTagged("next build", NEXT_BIN, ["build"], buildEnv);
    build.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`next build exited ${code}`))));
    build.once("error", reject);
  });

  const networkPromise = TestNetworkNoAppView.create();

  const [, network] = await Promise.all([buildPromise, networkPromise]);

  const ownerAgent = network.pds.getAgent();
  await ownerAgent.createAccount({ handle: OWNER_HANDLE, email: "owner@e2e.test", password: OWNER_PASSWORD });
  const ownerDid = ownerAgent.session!.did;

  const nonOwnerAgent = network.pds.getAgent();
  await nonOwnerAgent.createAccount({ handle: NON_OWNER_HANDLE, email: "nonowner@e2e.test", password: NON_OWNER_PASSWORD });

  const internalPort = await getPort();
  const publicPort = await getPort();
  const baseUrl = `https://${FAKE_HOST}:${publicPort}`;

  const sqlitePath = path.join(workDir, "session.db");
  const appEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PDS_URL: network.pds.url,
    OWNER_DID: ownerDid,
    PUBLIC_URL: baseUrl,
    SESSION_SECRET: randomBytes(32).toString("hex"),
    SQLITE_PATH: sqlitePath,
    OAUTH_JWK: await ephemeralOauthJwk(),
    // See lib/env.ts's own doc comment: unset in every real deployment.
    OAUTH_PLC_URL: network.plc.url,
  };
  const appProcess = spawnTagged("next start", NEXT_BIN, ["start", "-p", String(internalPort)], appEnv);
  await waitUntilReady(`http://127.0.0.1:${internalPort}/oauth/client-metadata.json`, 60_000);

  // Self-signed cert for FAKE_HOST, terminating TLS in front of the plain-
  // HTTP `next start` process above (see this file's header comment for why
  // this proxy exists at all rather than asking Next for HTTPS directly).
  const pems = await selfsigned.generate([{ name: "commonName", value: FAKE_HOST }], {
    keySize: 2048,
    notAfterDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: FAKE_HOST }] }],
  });
  const proxy = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    // Host header is forwarded UNCHANGED -- Next's Server Actions same-
    // origin check compares the request's Origin against its Host, and the
    // browser's Origin will be `https://FAKE_HOST:publicPort` throughout,
    // so the internal request's Host must keep matching that, not whatever
    // `127.0.0.1:internalPort` the proxy actually connects to.
    const proxyReq = http.request(
      { hostname: "127.0.0.1", port: internalPort, path: req.url, method: req.method, headers: req.headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(proxyReq);
  });
  await new Promise<void>((resolve) => proxy.listen(publicPort, "127.0.0.1", resolve));
  await waitUntilReady(`${baseUrl}/oauth/client-metadata.json`, 30_000);

  const fixturePath = path.join(workDir, "fixture.jpg");
  await writeFixtureJpeg(fixturePath);

  const configPath = path.join(workDir, "config.json");
  const e2eConfig: E2EConfig = {
    baseUrl,
    fakeHost: FAKE_HOST,
    ownerHandle: OWNER_HANDLE,
    ownerPassword: OWNER_PASSWORD,
    ownerDid,
    nonOwnerHandle: NON_OWNER_HANDLE,
    nonOwnerPassword: NON_OWNER_PASSWORD,
    fixturePath,
    fixtureTitle: FIXTURE_TITLE,
  };
  await writeFile(configPath, JSON.stringify(e2eConfig, null, 2));
  // Set (not returned) so spec files -- running in worker processes spawned
  // AFTER this function returns -- can find it; see this file's header
  // comment on why the same trick can't be used for the webServer's own env.
  process.env.E2E_CONFIG_PATH = configPath;

  return async () => {
    await exiftool.end();
    proxy.close();
    await killTree(appProcess);
    await network.close();
    await rm(workDir, { recursive: true, force: true });
  };
}
