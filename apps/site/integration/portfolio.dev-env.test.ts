import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestNetworkNoAppView } from "@atproto/dev-env";
import type { AtpAgent } from "@atproto/api";
import { readCar } from "@atproto/repo";
import { exiftool, type Tags } from "exiftool-vendored";
import sharp from "sharp";
import { OPENCONTENT_PHOTOGRAPH, type PhotographRecord } from "@open-portfolio/lexicons";
import { publishPhotographCore, saveCollectionCore } from "../app/admin/actions";
import { rkeyFromUri } from "../lib/at-uri";
import { blobRefCid } from "../lib/blob-ref";
import { openDb } from "../lib/db";
import { proxyImage } from "../lib/image-proxy";
import { bustCache, listAllRecords } from "../lib/pds";
import { collectionPhotographs, getPortfolio } from "../lib/portfolio";

// ── Real-PDS proof of the whole pipeline (Task A12) ─────────────────────────
// Ported from Luminance's apps/web/integration/social.dev-env.test.ts: a real
// local PDS (`@atproto/dev-env`'s TestNetworkNoAppView, SQLite-native, no
// Docker/Postgres) with env vars pointed at it, driving this app's actual
// production write path (`publishPhotographCore` / `saveCollectionCore` --
// the same `*Core` functions the admin server actions call, agent + ownerDid
// already resolved so no live OAuth session is needed, see app/admin/
// actions.ts's own doc comment) and its public read path (`getPortfolio()`,
// `proxyImage()`), which are wired to `env.PDS_URL`/`env.OWNER_DID` via
// lazy getters (lib/env.ts) -- setting `process.env` in `beforeAll`, before
// any of those modules is ever called, is enough to repoint the whole app at
// the dev PDS. No mocks, no stubbed agent: every assertion below checks data
// that really round-tripped through a real ATProto repo.
//
// Excluded from the default `pnpm test` (see vitest.config.ts's `exclude`);
// run explicitly with `pnpm --filter site test:integration`.

let network: TestNetworkNoAppView;
let agent: AtpAgent;
let ownerDid: string;
let origPdsUrl: string | undefined;
let origOwnerDid: string | undefined;

// dev-env's serviceHandleDomains include ".test" -- handles must end in one.
// "owner.test" is rejected by the dev-env PDS as a reserved handle.
const OWNER_HANDLE = "photographer.test";
const WIDTH = 800;
const HEIGHT = 500;

beforeAll(async () => {
  // Capture prior env values for restoration in afterAll.
  origPdsUrl = process.env.PDS_URL;
  origOwnerDid = process.env.OWNER_DID;

  network = await TestNetworkNoAppView.create();
  agent = network.pds.getAgent();
  await agent.createAccount({ handle: OWNER_HANDLE, email: "owner@test.com", password: "password" });
  ownerDid = agent.session!.did;

  // lib/env.ts's getters read process.env lazily, on every access -- so
  // setting these here, before publishPhotographCore/getPortfolio/
  // proxyImage are ever called, is enough to point every PDS-pinned
  // reader/writer in the app at this real dev-env instance.
  process.env.PDS_URL = network.pds.url;
  process.env.OWNER_DID = ownerDid;
}, 120_000);

afterAll(async () => {
  // exiftool-vendored keeps a child-process pool alive; without this the
  // vitest process never exits.
  await exiftool.end();
  await network?.close();

  // Restore prior env values; @atproto/dev-env's dual sharp versions are harmless.
  if (origPdsUrl !== undefined) {
    process.env.PDS_URL = origPdsUrl;
  } else {
    delete process.env.PDS_URL;
  }
  if (origOwnerDid !== undefined) {
    process.env.OWNER_DID = origOwnerDid;
  } else {
    delete process.env.OWNER_DID;
  }
});

// --- fixture: a real geotagged JPEG (sharp-generated base + exiftool GPS
// tags), mirroring lib/photo-metadata.test.ts's fixture pattern -- generated
// at test time, never a committed binary. ------------------------------------

async function withTempFile<T>(buf: Buffer, ext: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "portfolio-dev-env-"));
  const file = path.join(dir, `fixture${ext}`);
  try {
    await writeFile(file, buf);
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readTags(buf: Buffer, ext: string): Promise<Tags> {
  return withTempFile(buf, ext, (file) => exiftool.read(file));
}

async function geotaggedJpeg(): Promise<Buffer> {
  const base = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: "#4a6" } })
    .jpeg()
    .toBuffer();
  return withTempFile(base, ".jpg", async (file) => {
    await exiftool.write(
      file,
      { GPSLatitude: 40.7, GPSLongitude: -73.9, Make: "FUJIFILM", Model: "X-T5" },
      { writeArgs: ["-overwrite_original"] },
    );
    return readFile(file);
  });
}

describe("portfolio dev-env round-trip (real PDS)", () => {
  it("publish -> render -> dangling-ref -> CAR round-trip", async () => {
    // ── 1. publish a real geotagged JPEG through the actual write path ──────
    const original = await geotaggedJpeg();
    const publishForm = new FormData();
    publishForm.set("file", new File([new Uint8Array(original)], "ridge.jpg", { type: "image/jpeg" }));
    publishForm.set("title", "Ridge at dawn");
    publishForm.set("description", "First light over the ridge");
    publishForm.set("alt", "A mountain ridge lit by sunrise");
    publishForm.set("tags", "landscape, sunrise");
    publishForm.set("license", "CC-BY-4.0");
    publishForm.set("location", "Rocky Mountain NP");

    const publishResult = await publishPhotographCore(ownerDid, agent, publishForm);
    if (!publishResult.ok) throw new Error(`publish failed: ${publishResult.error}`);
    const photoUri = publishResult.uri;
    const photoRkey = rkeyFromUri(photoUri);

    // ── 2a. the created record really landed on the PDS, right shape ───────
    const photoEnvelopes = await listAllRecords<PhotographRecord>(OPENCONTENT_PHOTOGRAPH);
    const photoEnvelope = photoEnvelopes.find((r) => r.uri === photoUri);
    expect(photoEnvelope).toBeDefined();
    const photoRecord = photoEnvelope!.value;
    expect(photoRecord.$type).toBe(OPENCONTENT_PHOTOGRAPH);
    expect(photoRecord.title).toBe("Ridge at dawn");
    expect(photoRecord.description).toBe("First light over the ridge");
    expect(photoRecord.alt).toBe("A mountain ridge lit by sunrise");
    expect(photoRecord.tags).toEqual(["landscape", "sunrise"]);
    expect(photoRecord.license).toBe("CC-BY-4.0");
    expect(photoRecord.location).toBe("Rocky Mountain NP");
    expect(photoRecord.aspectRatio).toEqual({ width: WIDTH, height: HEIGHT });
    expect(photoRecord.image.mimeType).toBe("image/jpeg");

    const blobCid = blobRefCid(photoRecord.image.ref);
    expect(blobCid).toBeTruthy();

    // ── 2b. the invariant end-to-end: the blob actually stored on the PDS
    // (fetched back via getBlob, not the bytes we uploaded) carries zero GPS
    // tags, and its decoded pixels are byte-identical to the pre-strip
    // original (GPS stripping is metadata-only surgery, spec §9). ──────────
    const blobRes = await agent.com.atproto.sync.getBlob({ did: ownerDid, cid: blobCid! });
    const storedBytes = Buffer.from(blobRes.data);
    const storedTags = await readTags(storedBytes, ".jpg");
    expect(storedTags.GPSLatitude).toBeUndefined();
    expect(storedTags.GPSLongitude).toBeUndefined();
    expect(storedTags.Make).toBe("FUJIFILM"); // non-GPS metadata preserved
    const rawOriginal = await sharp(original).raw().toBuffer();
    const rawStored = await sharp(storedBytes).raw().toBuffer();
    expect(Buffer.compare(rawOriginal, rawStored)).toBe(0);

    // ── 3. saveCollectionCore referencing the photograph, then
    // getPortfolio() (bustCache first) returns the ordered data ────────────
    const collectionForm = new FormData();
    collectionForm.set("title", "Sunrise Collection");
    collectionForm.set("description", "Warm light, high places");
    collectionForm.set("items", JSON.stringify([{ uri: photoEnvelope!.uri, cid: photoEnvelope!.cid }]));

    const saveResult = await saveCollectionCore(ownerDid, agent, collectionForm);
    if (!saveResult.ok) throw new Error(`save collection failed: ${saveResult.error}`);
    const collectionRkey = rkeyFromUri(saveResult.uri);

    bustCache();
    const portfolioBefore = await getPortfolio();
    const orderedCollection = portfolioBefore.collections.find((c) => c.rkey === collectionRkey);
    expect(orderedCollection).toBeDefined();
    expect(orderedCollection!.record.title).toBe("Sunrise Collection");
    const resolvedBefore = collectionPhotographs(orderedCollection!.record, portfolioBefore.photographs);
    expect(resolvedBefore.map((r) => r.rkey)).toEqual([photoRkey]);
    const collectionCid = orderedCollection!.cid;

    // ── 6 (bonus). proxyImage() against the dev PDS blob -- allowlisted via
    // the live portfolio -- returns 200 + re-encoded bytes. Run this before
    // the photo is deleted below: the allowlist is portfolio-membership
    // based, so the photo must still exist. ─────────────────────────────────
    const db = openDb(":memory:");
    const proxied = await proxyImage(db, { cid: blobCid!, preset: "thumb", accept: "image/webp" });
    expect(proxied.status).toBe(200);
    expect(proxied.contentType).toBe("image/webp");
    const proxiedMeta = await sharp(proxied.body!).metadata();
    expect(proxiedMeta.format).toBe("webp");
    expect(proxiedMeta.width).toBeLessThanOrEqual(WIDTH); // resized to/under the thumb preset

    // ── 4. delete the photograph record directly via the agent, bustCache,
    // getPortfolio() skips the now-dangling ref rather than throwing ───────
    await agent.com.atproto.repo.deleteRecord({
      repo: ownerDid,
      collection: OPENCONTENT_PHOTOGRAPH,
      rkey: photoRkey,
    });
    bustCache();
    const portfolioAfter = await getPortfolio();
    expect(portfolioAfter.photographs.has(photoRkey)).toBe(false);
    const collectionAfter = portfolioAfter.collections.find((c) => c.rkey === collectionRkey);
    expect(collectionAfter).toBeDefined(); // the collection record itself is untouched by the photo's delete
    const resolvedAfter = collectionPhotographs(collectionAfter!.record, portfolioAfter.photographs);
    expect(resolvedAfter).toEqual([]); // dangling ref dropped silently, never thrown

    // ── 5. the full repo CAR (com.atproto.sync.getRepo) parses via
    // @atproto/repo's readCar and still contains the collection record's
    // CID -- a record's CID is a hash of its own content, so it's unaffected
    // by an unrelated delete elsewhere in the repo. ─────────────────────────
    const repoRes = await agent.com.atproto.sync.getRepo({ did: ownerDid });
    const { blocks } = await readCar(repoRes.data);
    const blockCids = blocks.cids().map((cid) => cid.toString());
    expect(blockCids).toContain(collectionCid);
  }, 120_000);
});
