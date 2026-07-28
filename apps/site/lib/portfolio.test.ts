import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionRecord, PhotographRecord, SiteRecord } from "@open-portfolio/lexicons";
import type { RecordEnvelope } from "./pds";
import {
  assemblePortfolio,
  collectionCover,
  collectionPhotographs,
  getPortfolio,
  homeFeed,
  neighborsInCollection,
} from "./portfolio";

const OWNER_DID = "did:plc:owner";

function photoEnv(rkey: string, overrides: Partial<PhotographRecord> = {}): RecordEnvelope<PhotographRecord> {
  return {
    uri: `at://${OWNER_DID}/social.opencontent.photograph/${rkey}`,
    cid: `cid-${rkey}`,
    value: {
      $type: "social.opencontent.photograph",
      image: { $type: "blob", ref: { $link: `blob-${rkey}` }, mimeType: "image/jpeg", size: 100 },
      aspectRatio: { width: 3, height: 2 },
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    },
  };
}

function collectionEnv(
  rkey: string,
  items: { uri: string; cid: string }[],
  overrides: Partial<CollectionRecord> = {},
): RecordEnvelope<CollectionRecord> {
  return {
    uri: `at://${OWNER_DID}/social.opencontent.collection/${rkey}`,
    cid: `cid-${rkey}`,
    value: {
      $type: "social.opencontent.collection",
      title: `Collection ${rkey}`,
      items,
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    },
  };
}

function refTo(photoEnvelope: RecordEnvelope<PhotographRecord>): { uri: string; cid: string } {
  return { uri: photoEnvelope.uri, cid: photoEnvelope.cid };
}

function site(overrides: Partial<SiteRecord> = {}): SiteRecord {
  return {
    $type: "social.opencontent.site",
    title: "My Portfolio",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("assemblePortfolio", () => {
  it("orders collections per site.collectionOrder, in that exact order", () => {
    const c1 = collectionEnv("c1", []);
    const c2 = collectionEnv("c2", []);
    const c3 = collectionEnv("c3", []);
    const result = assemblePortfolio(site({ collectionOrder: ["c3", "c1", "c2"] }), [c1, c2, c3], []);

    expect(result.collections.map((c) => c.rkey)).toEqual(["c3", "c1", "c2"]);
  });

  it("appends collections not in collectionOrder, newest-first, after the ordered ones", () => {
    const listed = collectionEnv("listed", [], { createdAt: "2020-01-01T00:00:00.000Z" });
    const older = collectionEnv("older", [], { createdAt: "2024-01-01T00:00:00.000Z" });
    const newer = collectionEnv("newer", [], { createdAt: "2025-06-01T00:00:00.000Z" });
    const result = assemblePortfolio(site({ collectionOrder: ["listed"] }), [older, newer, listed], []);

    expect(result.collections.map((c) => c.rkey)).toEqual(["listed", "newer", "older"]);
  });

  it("skips a dangling collectionOrder rkey (no matching collection) silently, without throwing", () => {
    const c1 = collectionEnv("c1", []);
    expect(() =>
      assemblePortfolio(site({ collectionOrder: ["ghost", "c1"] }), [c1], []),
    ).not.toThrow();

    const result = assemblePortfolio(site({ collectionOrder: ["ghost", "c1"] }), [c1], []);
    expect(result.collections.map((c) => c.rkey)).toEqual(["c1"]);
  });

  it("returns site: null and all collections newest-first when there is no site record", () => {
    const older = collectionEnv("older", [], { createdAt: "2024-01-01T00:00:00.000Z" });
    const newer = collectionEnv("newer", [], { createdAt: "2025-06-01T00:00:00.000Z" });
    const result = assemblePortfolio(null, [older, newer], []);

    expect(result.site).toBeNull();
    expect(result.collections.map((c) => c.rkey)).toEqual(["newer", "older"]);
  });

  it("builds the photographs map keyed by rkey, attaching the record's own cid", () => {
    const p1 = photoEnv("p1");
    const result = assemblePortfolio(null, [], [p1]);

    expect(result.photographs.size).toBe(1);
    expect(result.photographs.get("p1")).toEqual({ ...p1.value, cid: "cid-p1" });
  });

  it("de-duplicates a collectionOrder rkey listed twice", () => {
    const c1 = collectionEnv("c1", []);
    const result = assemblePortfolio(site({ collectionOrder: ["c1", "c1"] }), [c1], []);
    expect(result.collections.map((c) => c.rkey)).toEqual(["c1"]);
  });

  it("returns an empty collections array when there are none at all", () => {
    const result = assemblePortfolio(site(), [], []);
    expect(result.collections).toEqual([]);
  });
});

describe("collectionPhotographs", () => {
  it("resolves items in collection order", () => {
    const p1 = photoEnv("p1");
    const p2 = photoEnv("p2");
    const { photographs } = assemblePortfolio(null, [], [p1, p2]);
    const collection = collectionEnv("c1", [refTo(p2), refTo(p1)]).value;

    const resolved = collectionPhotographs(collection, photographs);
    expect(resolved.map((r) => r.rkey)).toEqual(["p2", "p1"]);
  });

  it("skips a dangling item ref (photograph no longer exists) silently, without throwing", () => {
    const p1 = photoEnv("p1");
    const { photographs } = assemblePortfolio(null, [], [p1]);
    const danglingRef = { uri: `at://${OWNER_DID}/social.opencontent.photograph/deleted`, cid: "cid-deleted" };
    const collection = collectionEnv("c1", [refTo(p1), danglingRef]).value;

    expect(() => collectionPhotographs(collection, photographs)).not.toThrow();
    const resolved = collectionPhotographs(collection, photographs);
    expect(resolved.map((r) => r.rkey)).toEqual(["p1"]);
  });

  it("returns an empty array for a collection with no items", () => {
    const { photographs } = assemblePortfolio(null, [], []);
    const collection = collectionEnv("c1", []).value;
    expect(collectionPhotographs(collection, photographs)).toEqual([]);
  });

  it("resolves to zero photographs when all items are dangling refs, without error", () => {
    const { photographs } = assemblePortfolio(null, [], []);
    const danglingRef1 = { uri: `at://${OWNER_DID}/social.opencontent.photograph/deleted1`, cid: "cid-deleted1" };
    const danglingRef2 = { uri: `at://${OWNER_DID}/social.opencontent.photograph/deleted2`, cid: "cid-deleted2" };
    const collection = collectionEnv("c1", [danglingRef1, danglingRef2]).value;

    expect(() => collectionPhotographs(collection, photographs)).not.toThrow();
    const resolved = collectionPhotographs(collection, photographs);
    expect(resolved).toEqual([]);
  });
});

describe("collectionCover", () => {
  it("resolves the cover strongRef to its photograph", () => {
    const p1 = photoEnv("p1");
    const { photographs } = assemblePortfolio(null, [], [p1]);
    const collection = collectionEnv("c1", [], { cover: refTo(p1) }).value;

    expect(collectionCover(collection, photographs)?.cid).toBe("cid-p1");
  });

  it("returns null when there is no cover set", () => {
    const { photographs } = assemblePortfolio(null, [], []);
    const collection = collectionEnv("c1", []).value;
    expect(collectionCover(collection, photographs)).toBeNull();
  });

  it("returns null (not throw) when the cover ref is dangling", () => {
    const { photographs } = assemblePortfolio(null, [], []);
    const danglingRef = { uri: `at://${OWNER_DID}/social.opencontent.photograph/deleted`, cid: "cid-deleted" };
    const collection = collectionEnv("c1", [], { cover: danglingRef }).value;
    expect(() => collectionCover(collection, photographs)).not.toThrow();
    expect(collectionCover(collection, photographs)).toBeNull();
  });
});

describe("homeFeed", () => {
  it("uses the first ordered collection's resolved photographs when collections exist", () => {
    const p1 = photoEnv("p1");
    const p2 = photoEnv("p2");
    const c1 = collectionEnv("c1", [refTo(p1)]);
    const c2 = collectionEnv("c2", [refTo(p2)]);
    const portfolio = assemblePortfolio(site({ collectionOrder: ["c1", "c2"] }), [c1, c2], [p1, p2]);

    const feed = homeFeed(portfolio);
    expect(feed.collection?.rkey).toBe("c1");
    expect(feed.photographs.map((p) => p.rkey)).toEqual(["p1"]);
  });

  it("falls back to all photographs reverse-chronological when there are no collections", () => {
    const older = photoEnv("older", { createdAt: "2024-01-01T00:00:00.000Z" });
    const newer = photoEnv("newer", { createdAt: "2025-06-01T00:00:00.000Z" });
    const portfolio = assemblePortfolio(null, [], [older, newer]);

    const feed = homeFeed(portfolio);
    expect(feed.collection).toBeNull();
    expect(feed.photographs.map((p) => p.rkey)).toEqual(["newer", "older"]);
  });
});

describe("neighborsInCollection", () => {
  it("finds prev/next within the (first) collection that contains the photograph", () => {
    const p1 = photoEnv("p1");
    const p2 = photoEnv("p2");
    const p3 = photoEnv("p3");
    const c1 = collectionEnv("c1", [refTo(p1), refTo(p2), refTo(p3)]);
    const portfolio = assemblePortfolio(site({ collectionOrder: ["c1"] }), [c1], [p1, p2, p3]);

    const middle = neighborsInCollection(portfolio, "p2");
    expect(middle.collection?.rkey).toBe("c1");
    expect(middle.prevRkey).toBe("p1");
    expect(middle.nextRkey).toBe("p3");

    const first = neighborsInCollection(portfolio, "p1");
    expect(first.prevRkey).toBeNull();
    expect(first.nextRkey).toBe("p2");
  });

  it("returns nulls when the photograph is in no collection", () => {
    const portfolio = assemblePortfolio(null, [], [photoEnv("orphan")]);
    const result = neighborsInCollection(portfolio, "orphan");
    expect(result.collection).toBeNull();
    expect(result.prevRkey).toBeNull();
    expect(result.nextRkey).toBeNull();
  });
});

describe("getPortfolio", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches the site record, all collections, and all photographs, then assembles them", async () => {
    const p1 = photoEnv("p1");
    const c1 = collectionEnv("c1", [refTo(p1)]);
    const siteRecord = site();

    const getRecordSpy = vi.fn(async () => ({ uri: "at://x/social.opencontent.site/self", cid: "site-cid", value: siteRecord }));
    const listAllRecordsSpy = vi.fn(async (collection: string) => {
      if (collection === "social.opencontent.collection") return [c1];
      if (collection === "social.opencontent.photograph") return [p1];
      throw new Error(`unexpected collection ${collection}`);
    });
    const cachedSpy = vi.fn(async (_key: string, _ttlMs: number, fn: () => Promise<unknown>) => fn());

    const result = await getPortfolio({
      getRecord: getRecordSpy as never,
      listAllRecords: listAllRecordsSpy as never,
      cached: cachedSpy as never,
    });

    expect(result.site).toEqual(siteRecord);
    expect(result.collections.map((c) => c.rkey)).toEqual(["c1"]);
    expect(result.photographs.get("p1")).toEqual({ ...p1.value, cid: "cid-p1" });
    expect(getRecordSpy).toHaveBeenCalledWith("social.opencontent.site", "self");
  });

  it("caches the assembled portfolio for 60s via the shared cached() TTL wrapper", async () => {
    const cachedSpy = vi.fn(async (_key: string, ttlMs: number, fn: () => Promise<unknown>) => {
      expect(ttlMs).toBe(60_000);
      return fn();
    });
    const getRecordSpy = vi.fn(async () => null);
    const listAllRecordsSpy = vi.fn(async () => []);

    await getPortfolio({ getRecord: getRecordSpy as never, listAllRecords: listAllRecordsSpy as never, cached: cachedSpy as never });

    expect(cachedSpy).toHaveBeenCalledTimes(1);
    expect(cachedSpy.mock.calls[0][0]).toEqual(expect.any(String));
  });

  it("resolves site: null when getRecord returns null (no site record published yet)", async () => {
    const getRecordSpy = vi.fn(async () => null);
    const listAllRecordsSpy = vi.fn(async () => []);
    const cachedSpy = vi.fn(async (_key: string, _ttlMs: number, fn: () => Promise<unknown>) => fn());

    const result = await getPortfolio({ getRecord: getRecordSpy as never, listAllRecords: listAllRecordsSpy as never, cached: cachedSpy as never });
    expect(result.site).toBeNull();
  });
});
