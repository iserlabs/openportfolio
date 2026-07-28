import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Agent } from "@atproto/api";
import { exiftool } from "exiftool-vendored";
import sharp from "sharp";
import type { Prefill } from "../../lib/photo-metadata";
import {
  publishPhotographCore,
  saveCollectionCore,
  deleteRecordActionCore,
  saveSiteCore,
  publishPhotograph,
} from "./actions";

// Wrapper-level test (see bottom of file) needs requireOwner() to throw
// without a live iron-session/cookie request context -- mocking the
// session module is the only way to drive the REAL exported
// `publishPhotograph` (not just its Core) down the non-owner path, proving
// the wrapper's own requireOwner()-first wiring rather than re-testing
// logic Core already covers.
vi.mock("../../lib/session", () => ({
  requireOwner: vi.fn(async () => {
    throw new Error("owner only");
  }),
}));

const OWNER_DID = "did:plc:owner";
const PHOTOGRAPH_COLLECTION = "social.opencontent.photograph";
const COLLECTION_COLLECTION = "social.opencontent.collection";
const SITE_COLLECTION = "social.opencontent.site";

// ---- fake agent (Luminance's `makeFakeAgent` pattern, from
// apps/web/lib/interactions.test.ts): records every `com.atproto.repo.*` /
// `uploadBlob` call it receives, defaulting to sane success responses that
// each test overrides only where its scenario needs to differ. ------------

function makeFakeAgent(opts: {
  // Typed with (data, opts) params (matching the real agent.uploadBlob
  // signature) rather than 0-arg, so vi.fn()'s inferred call-args tuple
  // lets tests read `.mock.calls[0][0]` (the actual bytes uploaded) --
  // used by the real-photo-metadata integration tests below.
  uploadBlob?: (data: unknown, opts: unknown) => Promise<{ data: { blob: unknown } }>;
  createRecord?: (input: unknown) => Promise<{ data: { uri: string; cid: string } }>;
  putRecord?: (input: unknown) => Promise<{ data: { uri: string; cid: string } }>;
  deleteRecord?: (input: unknown) => Promise<{ data: Record<string, never> }>;
  listRecords?: (
    input: unknown,
  ) => Promise<{ data: { cursor?: string; records: { uri: string; cid: string; value: unknown }[] } }>;
} = {}) {
  const uploadBlob = vi.fn(
    opts.uploadBlob ?? (async () => ({ data: { blob: { ref: "fake-cid-ref", mimeType: "image/jpeg", size: 12345 } } })),
  );
  const createRecord = vi.fn(
    opts.createRecord ??
      (async () => ({ data: { uri: `at://${OWNER_DID}/${PHOTOGRAPH_COLLECTION}/r1`, cid: "bafyrec1" } })),
  );
  const putRecord = vi.fn(
    opts.putRecord ?? (async () => ({ data: { uri: `at://${OWNER_DID}/${COLLECTION_COLLECTION}/r1`, cid: "bafyrec1" } })),
  );
  const deleteRecord = vi.fn(opts.deleteRecord ?? (async () => ({ data: {} })));
  const listRecords = vi.fn(opts.listRecords ?? (async () => ({ data: { records: [] } })));
  const agent = {
    uploadBlob,
    com: { atproto: { repo: { createRecord, putRecord, deleteRecord, listRecords } } },
  };
  return { agent: agent as unknown as Agent, uploadBlob, createRecord, putRecord, deleteRecord, listRecords };
}

function makeImageFile(bytes: number[] = [1, 2, 3], type = "image/jpeg", name = "photo.jpg"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function fakePrefill(overrides: Partial<Prefill> = {}): Prefill {
  return { tags: [], exif: {}, width: 4000, height: 3000, hasGps: false, ...overrides };
}

function publishFormData(fields: Record<string, string> = {}, file: File | null = makeImageFile()): FormData {
  const fd = new FormData();
  if (file) fd.set("file", file);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("publishPhotographCore", () => {
  it("rejects a non-owner (ownerDid null) before ever touching the agent", async () => {
    const { agent, uploadBlob, createRecord } = makeFakeAgent();
    const stripGps = vi.fn(async (b: Buffer) => b);
    const extractPrefill = vi.fn(async () => fakePrefill());

    const result = await publishPhotographCore(null, agent, publishFormData(), { stripGps, extractPrefill });

    expect(result.ok).toBe(false);
    expect(uploadBlob).not.toHaveBeenCalled();
    expect(createRecord).not.toHaveBeenCalled();
    expect(stripGps).not.toHaveBeenCalled();
  });

  it("uploads the blob then creates the record with $type social.opencontent.photograph, threading the returned blob ref through", async () => {
    const { agent, uploadBlob, createRecord } = makeFakeAgent({
      uploadBlob: async () => ({ data: { blob: { ref: "cid-abc", mimeType: "image/jpeg", size: 999 } } }),
    });
    const stripGps = vi.fn(async (b: Buffer) => b);
    const extractPrefill = vi.fn(async () => fakePrefill({ width: 1200, height: 800 }));

    const result = await publishPhotographCore(
      OWNER_DID,
      agent,
      publishFormData({ title: "Low tide" }),
      { stripGps, extractPrefill },
    );

    expect(result).toEqual({ ok: true, uri: `at://${OWNER_DID}/${PHOTOGRAPH_COLLECTION}/r1` });
    expect(uploadBlob).toHaveBeenCalledTimes(1);
    expect(uploadBlob).toHaveBeenCalledWith(expect.any(Buffer), { encoding: "image/jpeg" });
    expect(createRecord).toHaveBeenCalledWith({
      repo: OWNER_DID,
      collection: PHOTOGRAPH_COLLECTION,
      record: expect.objectContaining({
        $type: PHOTOGRAPH_COLLECTION,
        title: "Low tide",
        aspectRatio: { width: 1200, height: 800 },
        image: { $type: "blob", ref: "cid-abc", mimeType: "image/jpeg", size: 999 },
      }),
    });
  });

  it("strips GPS by default when extractPrefill reports hasGps===true (keepGps not set)", async () => {
    const { agent } = makeFakeAgent();
    const stripGps = vi.fn(async (b: Buffer) => b);
    const extractPrefill = vi.fn(async () => fakePrefill({ hasGps: true }));

    const result = await publishPhotographCore(OWNER_DID, agent, publishFormData(), { stripGps, extractPrefill });

    expect(result.ok).toBe(true);
    expect(stripGps).toHaveBeenCalledTimes(1);
  });

  it("skips GPS-strip when keepGps==='true', even if extractPrefill reports hasGps===true", async () => {
    const { agent } = makeFakeAgent();
    const stripGps = vi.fn(async (b: Buffer) => b);
    const extractPrefill = vi.fn(async () => fakePrefill({ hasGps: true }));

    const result = await publishPhotographCore(
      OWNER_DID,
      agent,
      publishFormData({ keepGps: "true" }),
      { stripGps, extractPrefill },
    );

    expect(result.ok).toBe(true);
    expect(stripGps).not.toHaveBeenCalled();
  });

  // Review finding: stripGps unconditionally rejects AVIF, so unconditionally
  // calling it for every non-keepGps upload broke GPS-free AVIF uploads.
  // extractPrefill's hasGps now gates the call entirely.
  it("skips GPS-strip (no call at all) when extractPrefill reports hasGps===false, even with keepGps not set", async () => {
    const { agent } = makeFakeAgent();
    const stripGps = vi.fn(async (b: Buffer) => b);
    const extractPrefill = vi.fn(async () => fakePrefill({ hasGps: false }));

    const result = await publishPhotographCore(OWNER_DID, agent, publishFormData(), { stripGps, extractPrefill });

    expect(result.ok).toBe(true);
    expect(stripGps).not.toHaveBeenCalled();
  });

  it("surfaces stripGps's own actionable error when hasGps===true but stripGps throws (e.g. AVIF-with-GPS), never publishing", async () => {
    const { agent, uploadBlob } = makeFakeAgent();
    const stripGps = vi.fn(async () => {
      throw new Error("gps strip unsupported for avif; re-export without location");
    });
    const extractPrefill = vi.fn(async () => fakePrefill({ hasGps: true }));

    const result = await publishPhotographCore(OWNER_DID, agent, publishFormData(), { stripGps, extractPrefill });

    expect(result).toEqual({
      ok: false,
      error: "gps strip unsupported for avif; re-export without location",
    });
    expect(uploadBlob).not.toHaveBeenCalled();
  });

  it("maps a 413/BlobTooLarge uploadBlob failure to {ok:false, code:'too-large'}, naming the parsed limit", async () => {
    const tooLargeErr = Object.assign(
      new Error("Blob size 6000000 bytes exceeds the maximum allowed size of 5242880 bytes"),
      { status: 413, error: "BlobTooLarge" },
    );
    const { agent, createRecord } = makeFakeAgent({
      uploadBlob: async () => {
        throw tooLargeErr;
      },
    });
    const stripGps = vi.fn(async (b: Buffer) => b);
    const extractPrefill = vi.fn(async () => fakePrefill());

    const result = await publishPhotographCore(OWNER_DID, agent, publishFormData(), { stripGps, extractPrefill });

    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("too-large");
    expect((result as { error: string }).error).toContain("5MB");
    expect(createRecord).not.toHaveBeenCalled();
  });

  it("maps a 413 failure with no parseable limit to a generic too-large message, not a throw", async () => {
    const { agent } = makeFakeAgent({
      uploadBlob: async () => {
        throw Object.assign(new Error("payload too large"), { status: 413 });
      },
    });
    const stripGps = vi.fn(async (b: Buffer) => b);
    const extractPrefill = vi.fn(async () => fakePrefill());

    const result = await publishPhotographCore(OWNER_DID, agent, publishFormData(), { stripGps, extractPrefill });

    expect(result).toMatchObject({ ok: false, code: "too-large" });
  });

  it("every ok path busts the cache", async () => {
    const { agent } = makeFakeAgent();
    const stripGps = vi.fn(async (b: Buffer) => b);
    const extractPrefill = vi.fn(async () => fakePrefill());
    const bustCache = vi.fn();

    const result = await publishPhotographCore(OWNER_DID, agent, publishFormData(), {
      stripGps,
      extractPrefill,
      bustCache,
    });

    expect(result.ok).toBe(true);
    expect(bustCache).toHaveBeenCalledTimes(1);
  });

  it("does NOT bust the cache when the publish fails", async () => {
    const { agent } = makeFakeAgent({
      uploadBlob: async () => {
        throw new Error("boom");
      },
    });
    const stripGps = vi.fn(async (b: Buffer) => b);
    const extractPrefill = vi.fn(async () => fakePrefill());
    const bustCache = vi.fn();

    const result = await publishPhotographCore(OWNER_DID, agent, publishFormData(), {
      stripGps,
      extractPrefill,
      bustCache,
    });

    expect(result.ok).toBe(false);
    expect(bustCache).not.toHaveBeenCalled();
  });

  it("rejects an unsupported image type (e.g. SVG) before ever calling uploadBlob or stripGps", async () => {
    const { agent, uploadBlob } = makeFakeAgent();
    const stripGps = vi.fn(async (b: Buffer) => b);
    const extractPrefill = vi.fn(async () => fakePrefill());
    const svg = makeImageFile([1, 2, 3], "image/svg+xml", "evil.svg");

    const result = await publishPhotographCore(OWNER_DID, agent, publishFormData({}, svg), {
      stripGps,
      extractPrefill,
    });

    expect(result.ok).toBe(false);
    expect(uploadBlob).not.toHaveBeenCalled();
    expect(stripGps).not.toHaveBeenCalled();
  });

  it("returns {ok:false} when no file field is present, without touching the agent", async () => {
    const { agent, uploadBlob } = makeFakeAgent();

    const result = await publishPhotographCore(OWNER_DID, agent, publishFormData({}, null));

    expect(result.ok).toBe(false);
    expect(uploadBlob).not.toHaveBeenCalled();
  });
});

describe("saveCollectionCore", () => {
  function collectionFormData(fields: Record<string, string> = {}): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  }

  it("rejects a non-owner before touching the agent", async () => {
    const { agent, createRecord, putRecord } = makeFakeAgent();

    const result = await saveCollectionCore(null, agent, collectionFormData({ title: "Herons" }));

    expect(result.ok).toBe(false);
    expect(createRecord).not.toHaveBeenCalled();
    expect(putRecord).not.toHaveBeenCalled();
  });

  it("creates via createRecord (server-assigned TID) when no rkey is supplied", async () => {
    const { agent, createRecord, putRecord } = makeFakeAgent({
      createRecord: async () => ({ data: { uri: `at://${OWNER_DID}/${COLLECTION_COLLECTION}/r1`, cid: "bafyrec1" } }),
    });

    const result = await saveCollectionCore(OWNER_DID, agent, collectionFormData({ title: "Herons" }));

    expect(result).toEqual({ ok: true, uri: `at://${OWNER_DID}/${COLLECTION_COLLECTION}/r1` });
    expect(createRecord).toHaveBeenCalledWith({
      repo: OWNER_DID,
      collection: COLLECTION_COLLECTION,
      record: expect.objectContaining({ title: "Herons", items: [] }),
    });
    expect(putRecord).not.toHaveBeenCalled();
  });

  it("full-rewrites via putRecord with the given rkey when one is supplied (edit / reorder)", async () => {
    const { agent, createRecord, putRecord } = makeFakeAgent();
    const items = JSON.stringify([
      { uri: `at://${OWNER_DID}/${PHOTOGRAPH_COLLECTION}/p2`, cid: "bafyp2" },
      { uri: `at://${OWNER_DID}/${PHOTOGRAPH_COLLECTION}/p1`, cid: "bafyp1" },
    ]);

    const result = await saveCollectionCore(
      OWNER_DID,
      agent,
      collectionFormData({ title: "Herons", rkey: "existing1", items }),
    );

    expect(result.ok).toBe(true);
    expect(putRecord).toHaveBeenCalledWith({
      repo: OWNER_DID,
      collection: COLLECTION_COLLECTION,
      rkey: "existing1",
      record: expect.objectContaining({
        items: [
          { uri: `at://${OWNER_DID}/${PHOTOGRAPH_COLLECTION}/p2`, cid: "bafyp2" },
          { uri: `at://${OWNER_DID}/${PHOTOGRAPH_COLLECTION}/p1`, cid: "bafyp1" },
        ],
      }),
    });
    expect(createRecord).not.toHaveBeenCalled();
  });

  it("rejects malformed items JSON before touching the agent", async () => {
    const { agent, createRecord } = makeFakeAgent();

    const result = await saveCollectionCore(
      OWNER_DID,
      agent,
      collectionFormData({ title: "Herons", items: "not json" }),
    );

    expect(result.ok).toBe(false);
    expect(createRecord).not.toHaveBeenCalled();
  });

  it("busts the cache on the ok path", async () => {
    const { agent } = makeFakeAgent();
    const bustCache = vi.fn();

    const result = await saveCollectionCore(OWNER_DID, agent, collectionFormData({ title: "Herons" }), { bustCache });

    expect(result.ok).toBe(true);
    expect(bustCache).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing title before touching the agent", async () => {
    const { agent, createRecord } = makeFakeAgent();

    const result = await saveCollectionCore(OWNER_DID, agent, collectionFormData({}));

    expect(result.ok).toBe(false);
    expect(createRecord).not.toHaveBeenCalled();
  });
});

describe("deleteRecordActionCore", () => {
  function deleteFormData(fields: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  }

  const PHOTO_RKEY = "photo1";
  const PHOTO_URI = `at://${OWNER_DID}/${PHOTOGRAPH_COLLECTION}/${PHOTO_RKEY}`;

  it("rejects a non-owner before touching the agent", async () => {
    const { agent, deleteRecord, listRecords } = makeFakeAgent();

    const result = await deleteRecordActionCore(
      null,
      agent,
      deleteFormData({ collection: PHOTOGRAPH_COLLECTION, rkey: PHOTO_RKEY }),
    );

    expect(result.ok).toBe(false);
    expect(deleteRecord).not.toHaveBeenCalled();
    expect(listRecords).not.toHaveBeenCalled();
  });

  it("blocks deleting a photograph still referenced by a collection, naming the referencing collection(s)", async () => {
    const { agent, deleteRecord } = makeFakeAgent({
      listRecords: async () => ({
        data: {
          records: [
            {
              uri: `at://${OWNER_DID}/${COLLECTION_COLLECTION}/c1`,
              cid: "bafyc1",
              value: { title: "Shorebirds", items: [{ uri: PHOTO_URI, cid: "bafyphoto1" }] },
            },
          ],
        },
      }),
    });

    const result = await deleteRecordActionCore(
      OWNER_DID,
      agent,
      deleteFormData({ collection: PHOTOGRAPH_COLLECTION, rkey: PHOTO_RKEY }),
    );

    expect(result).toMatchObject({ ok: false, code: "referenced", collections: ["Shorebirds"] });
    expect(deleteRecord).not.toHaveBeenCalled();
  });

  it("deletes anyway when force==='true', even though a collection still references it", async () => {
    const { agent, deleteRecord } = makeFakeAgent({
      listRecords: async () => ({
        data: {
          records: [
            {
              uri: `at://${OWNER_DID}/${COLLECTION_COLLECTION}/c1`,
              cid: "bafyc1",
              value: { title: "Shorebirds", items: [{ uri: PHOTO_URI, cid: "bafyphoto1" }] },
            },
          ],
        },
      }),
    });

    const result = await deleteRecordActionCore(
      OWNER_DID,
      agent,
      deleteFormData({ collection: PHOTOGRAPH_COLLECTION, rkey: PHOTO_RKEY, force: "true" }),
    );

    expect(result).toEqual({ ok: true });
    expect(deleteRecord).toHaveBeenCalledWith({ repo: OWNER_DID, collection: PHOTOGRAPH_COLLECTION, rkey: PHOTO_RKEY });
  });

  it("deletes a photograph normally when no collection references it", async () => {
    const { agent, deleteRecord, listRecords } = makeFakeAgent();

    const result = await deleteRecordActionCore(
      OWNER_DID,
      agent,
      deleteFormData({ collection: PHOTOGRAPH_COLLECTION, rkey: PHOTO_RKEY }),
    );

    expect(result).toEqual({ ok: true });
    expect(listRecords).toHaveBeenCalledTimes(1);
    expect(deleteRecord).toHaveBeenCalledWith({ repo: OWNER_DID, collection: PHOTOGRAPH_COLLECTION, rkey: PHOTO_RKEY });
  });

  it("skips the referenced-by check entirely when deleting a non-photograph collection", async () => {
    const { agent, deleteRecord, listRecords } = makeFakeAgent();

    const result = await deleteRecordActionCore(
      OWNER_DID,
      agent,
      deleteFormData({ collection: COLLECTION_COLLECTION, rkey: "c1" }),
    );

    expect(result).toEqual({ ok: true });
    expect(listRecords).not.toHaveBeenCalled();
    expect(deleteRecord).toHaveBeenCalledWith({ repo: OWNER_DID, collection: COLLECTION_COLLECTION, rkey: "c1" });
  });

  it("rejects an unsupported collection value, never touching deleteRecord", async () => {
    const { agent, deleteRecord } = makeFakeAgent();

    const result = await deleteRecordActionCore(
      OWNER_DID,
      agent,
      deleteFormData({ collection: "app.bsky.actor.profile", rkey: "self" }),
    );

    expect(result.ok).toBe(false);
    expect(deleteRecord).not.toHaveBeenCalled();
  });

  it("busts the cache only on the actual delete, not on the referenced-block", async () => {
    const referencing = makeFakeAgent({
      listRecords: async () => ({
        data: {
          records: [
            {
              uri: `at://${OWNER_DID}/${COLLECTION_COLLECTION}/c1`,
              cid: "bafyc1",
              value: { title: "Shorebirds", items: [{ uri: PHOTO_URI, cid: "bafyphoto1" }] },
            },
          ],
        },
      }),
    });
    const blockedBustCache = vi.fn();
    const blocked = await deleteRecordActionCore(
      OWNER_DID,
      referencing.agent,
      deleteFormData({ collection: PHOTOGRAPH_COLLECTION, rkey: PHOTO_RKEY }),
      { bustCache: blockedBustCache },
    );
    expect(blocked.ok).toBe(false);
    expect(blockedBustCache).not.toHaveBeenCalled();

    const clean = makeFakeAgent();
    const okBustCache = vi.fn();
    const ok = await deleteRecordActionCore(
      OWNER_DID,
      clean.agent,
      deleteFormData({ collection: PHOTOGRAPH_COLLECTION, rkey: PHOTO_RKEY }),
      { bustCache: okBustCache },
    );
    expect(ok.ok).toBe(true);
    expect(okBustCache).toHaveBeenCalledTimes(1);
  });
});

describe("saveSiteCore", () => {
  function siteFormData(fields: Record<string, string> = {}): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  }

  it("rejects a non-owner before touching the agent", async () => {
    const { agent, putRecord } = makeFakeAgent();

    const result = await saveSiteCore(null, agent, siteFormData({ title: "My Portfolio" }));

    expect(result.ok).toBe(false);
    expect(putRecord).not.toHaveBeenCalled();
  });

  it("always upserts via putRecord at rkey 'self'", async () => {
    const { agent, putRecord } = makeFakeAgent({
      putRecord: async () => ({ data: { uri: `at://${OWNER_DID}/${SITE_COLLECTION}/self`, cid: "bafysite1" } }),
    });

    const result = await saveSiteCore(OWNER_DID, agent, siteFormData({ title: "My Portfolio", about: "Hi." }));

    expect(result).toEqual({ ok: true, uri: `at://${OWNER_DID}/${SITE_COLLECTION}/self` });
    expect(putRecord).toHaveBeenCalledWith({
      repo: OWNER_DID,
      collection: SITE_COLLECTION,
      rkey: "self",
      record: expect.objectContaining({ title: "My Portfolio", about: "Hi." }),
    });
  });

  it("rejects a missing title before touching the agent", async () => {
    const { agent, putRecord } = makeFakeAgent();

    const result = await saveSiteCore(OWNER_DID, agent, siteFormData({}));

    expect(result.ok).toBe(false);
    expect(putRecord).not.toHaveBeenCalled();
  });

  it("busts the cache on the ok path", async () => {
    const { agent } = makeFakeAgent();
    const bustCache = vi.fn();

    const result = await saveSiteCore(OWNER_DID, agent, siteFormData({ title: "My Portfolio" }), { bustCache });

    expect(result.ok).toBe(true);
    expect(bustCache).toHaveBeenCalledTimes(1);
  });
});

// ---- publishPhotographCore, real photo-metadata (no stubs) -----------------
//
// The stubbed tests above prove the gating LOGIC (call stripGps iff hasGps
// && !keepGps) against a controlled fakePrefill. These prove the same
// gating against REAL extractPrefill/stripGps (imported by actions.ts by
// default -- no `deps` override passed here), on real image bytes, for
// exactly the combination the review finding was about: AVIF, which
// stripGps unconditionally refuses to touch. Fixture helpers mirror
// lib/photo-metadata.test.ts's (fixtures generated at test time, never
// committed binaries); exiftool-vendored's child-process pool must be
// shut down in afterAll or the test runner hangs.

describe("publishPhotographCore (real photo-metadata, no stubs)", () => {
  async function withTempFile<T>(buf: Buffer, ext: string, fn: (file: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "actions-test-"));
    const file = path.join(dir, `fixture${ext}`);
    try {
      await writeFile(file, buf);
      return await fn(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function writeTags(buf: Buffer, ext: string, tags: Record<string, unknown>): Promise<Buffer> {
    return withTempFile(buf, ext, async (file) => {
      await exiftool.write(file, tags, { writeArgs: ["-overwrite_original"] });
      return readFile(file);
    });
  }

  async function readGpsTags(buf: Buffer, ext: string) {
    return withTempFile(buf, ext, (file) => exiftool.read(file));
  }

  afterAll(async () => {
    await exiftool.end();
  });

  function realPublishFormData(file: File): FormData {
    const fd = new FormData();
    fd.set("file", file);
    return fd;
  }

  it("JPEG-with-GPS, default path: publishes bytes with GPS stripped (zero GPS tags), other metadata preserved", async () => {
    const base = await sharp({ create: { width: 20, height: 15, channels: 3, background: "#357" } }).jpeg().toBuffer();
    const geotagged = await writeTags(base, ".jpg", { GPSLatitude: 40.7, GPSLongitude: -73.9, Make: "FUJIFILM" });
    const { agent, uploadBlob } = makeFakeAgent();
    const file = new File([new Uint8Array(geotagged)], "geo.jpg", { type: "image/jpeg" });

    const result = await publishPhotographCore(OWNER_DID, agent, realPublishFormData(file));

    expect(result.ok).toBe(true);
    expect(uploadBlob).toHaveBeenCalledTimes(1);
    const uploadedBytes = uploadBlob.mock.calls[0]?.[0] as Buffer;
    const tags = await readGpsTags(uploadedBytes, ".jpg");
    expect(tags.GPSLatitude).toBeUndefined();
    expect(tags.GPSLongitude).toBeUndefined();
    expect(tags.Make).toBe("FUJIFILM");
  }, 30_000);

  it("AVIF-without-GPS, default path: publishes (hasGps===false means stripGps -- which would reject AVIF -- is never called)", async () => {
    const base = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#357" } }).avif().toBuffer();
    const { agent, uploadBlob } = makeFakeAgent();
    const file = new File([new Uint8Array(base)], "plain.avif", { type: "image/avif" });

    const result = await publishPhotographCore(OWNER_DID, agent, realPublishFormData(file));

    expect(result.ok).toBe(true);
    expect(uploadBlob).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("AVIF-with-GPS, default path: {ok:false} with stripGps's actionable message, never uploads a geotagged blob", async () => {
    const base = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#357" } }).avif().toBuffer();
    const avifGeotagged = await writeTags(base, ".avif", { GPSLatitude: 40.7, GPSLongitude: -73.9 });
    const { agent, uploadBlob } = makeFakeAgent();
    const file = new File([new Uint8Array(avifGeotagged)], "geo.avif", { type: "image/avif" });

    const result = await publishPhotographCore(OWNER_DID, agent, realPublishFormData(file));

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/avif/i);
    expect(uploadBlob).not.toHaveBeenCalled();
  }, 30_000);
});

// ---- publishPhotograph (exported wrapper) -----------------------------------
//
// Everything above drives publishPhotographCore directly. This proves the
// real exported action's own wiring: requireOwner() is called (mocked, via
// vi.mock("../../lib/session") at top of file, to throw without a live
// request/cookie context) BEFORE restoreAgent()/Core ever run, and the
// thrown error is caught and mapped to a result -- never an uncaught
// rejection reaching whatever called the server action.

describe("publishPhotograph (wrapper)", () => {
  it("returns {ok:false} when requireOwner() rejects, proving the wrapper's own gate (not just Core's)", async () => {
    const result = await publishPhotograph(new FormData());
    expect(result.ok).toBe(false);
  });
});
