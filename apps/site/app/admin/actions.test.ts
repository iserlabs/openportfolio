import { describe, it, expect, vi } from "vitest";
import type { Agent } from "@atproto/api";
import type { Prefill } from "../../lib/photo-metadata";
import {
  publishPhotographCore,
  saveCollectionCore,
  deleteRecordActionCore,
  saveSiteCore,
} from "./actions";

const OWNER_DID = "did:plc:owner";
const PHOTOGRAPH_COLLECTION = "social.opencontent.photograph";
const COLLECTION_COLLECTION = "social.opencontent.collection";
const SITE_COLLECTION = "social.opencontent.site";

// ---- fake agent (Luminance's `makeFakeAgent` pattern, from
// apps/web/lib/interactions.test.ts): records every `com.atproto.repo.*` /
// `uploadBlob` call it receives, defaulting to sane success responses that
// each test overrides only where its scenario needs to differ. ------------

function makeFakeAgent(opts: {
  uploadBlob?: () => Promise<{ data: { blob: unknown } }>;
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

  it("strips GPS by default (keepGps not set)", async () => {
    const { agent } = makeFakeAgent();
    const stripGps = vi.fn(async (b: Buffer) => b);
    const extractPrefill = vi.fn(async () => fakePrefill());

    const result = await publishPhotographCore(OWNER_DID, agent, publishFormData(), { stripGps, extractPrefill });

    expect(result.ok).toBe(true);
    expect(stripGps).toHaveBeenCalledTimes(1);
  });

  it("skips GPS-strip when keepGps==='true'", async () => {
    const { agent } = makeFakeAgent();
    const stripGps = vi.fn(async (b: Buffer) => b);
    const extractPrefill = vi.fn(async () => fakePrefill());

    const result = await publishPhotographCore(
      OWNER_DID,
      agent,
      publishFormData({ keepGps: "true" }),
      { stripGps, extractPrefill },
    );

    expect(result.ok).toBe(true);
    expect(stripGps).not.toHaveBeenCalled();
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
