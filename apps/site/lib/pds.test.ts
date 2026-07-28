import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blobUrl, bustCache, cached, getRecord, listAllRecords } from "./pds.js";

const OWNER_DID = "did:plc:kevin";
const PDS_URL = "https://pds.example.com";

beforeEach(() => {
  process.env.PDS_URL = PDS_URL;
  process.env.OWNER_DID = OWNER_DID;
});

afterEach(() => {
  bustCache(); // module-level cache Map is a singleton — never leak state across tests
  vi.useRealTimers();
});

describe("listAllRecords", () => {
  it("pages com.atproto.repo.listRecords at limit=100, joining pages until cursor is absent", async () => {
    const calls: string[] = [];
    const fetchJson = async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      expect(u.origin).toBe(PDS_URL);
      expect(u.pathname).toBe("/xrpc/com.atproto.repo.listRecords");
      expect(u.searchParams.get("repo")).toBe(OWNER_DID);
      expect(u.searchParams.get("collection")).toBe("social.opencontent.photograph");
      expect(u.searchParams.get("limit")).toBe("100");
      const cursor = u.searchParams.get("cursor");
      if (!cursor) {
        return { records: [rec("p1"), rec("p2")], cursor: "page2" };
      }
      if (cursor === "page2") {
        return { records: [rec("p3"), rec("p4")], cursor: "page3" };
      }
      if (cursor === "page3") {
        return { records: [rec("p5")] }; // no cursor -> paging stops
      }
      throw new Error(`unexpected cursor ${cursor}`);
    };

    const result = await listAllRecords("social.opencontent.photograph", fetchJson);

    expect(calls).toHaveLength(3);
    expect(result.map((r) => r.uri)).toEqual([
      atUri("p1"),
      atUri("p2"),
      atUri("p3"),
      atUri("p4"),
      atUri("p5"),
    ]);
    expect(result[0]).toEqual({ uri: atUri("p1"), cid: "bafyp1", value: { title: "p1" } });
  });

  it("caps at 5000 records and stops issuing further requests once the cap is reached", async () => {
    let callCount = 0;
    const fetchJson = async () => {
      callCount++;
      const records = Array.from({ length: 100 }, (_, i) => rec(`r${callCount}-${i}`));
      return { records, cursor: "more" }; // always another page available
    };

    const result = await listAllRecords("social.opencontent.photograph", fetchJson);

    expect(result).toHaveLength(5000);
    expect(callCount).toBe(50); // 5000 / 100 per page
  });

  it("never targets a URL outside the pinned PDS_URL origin, even with an adversarial collection value", async () => {
    const fetchJson = async (url: string) => {
      expect(new URL(url).origin).toBe(PDS_URL);
      return { records: [] };
    };
    await listAllRecords("http://evil.example.com/steal", fetchJson);
  });
});

describe("getRecord", () => {
  it("fetches com.atproto.repo.getRecord with repo/collection/rkey", async () => {
    const fetchJson = async (url: string) => {
      const u = new URL(url);
      expect(u.origin).toBe(PDS_URL);
      expect(u.pathname).toBe("/xrpc/com.atproto.repo.getRecord");
      expect(u.searchParams.get("repo")).toBe(OWNER_DID);
      expect(u.searchParams.get("collection")).toBe("social.opencontent.site");
      expect(u.searchParams.get("rkey")).toBe("self");
      return { uri: atUri("self", "social.opencontent.site"), cid: "bafyself", value: { title: "My Site" } };
    };

    const result = await getRecord("social.opencontent.site", "self", fetchJson);
    expect(result).toEqual({ uri: atUri("self", "social.opencontent.site"), cid: "bafyself", value: { title: "My Site" } });
  });
});

describe("blobUrl", () => {
  it("builds a getBlob URL against the pinned PDS_URL, percent-encoding the DID", () => {
    process.env.OWNER_DID = "did:plc:has special/chars";
    const url = blobUrl("bafyreicid123");
    expect(url).toBe(
      `${PDS_URL}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent("did:plc:has special/chars")}&cid=bafyreicid123`,
    );
  });

  it("percent-encodes the cid too", () => {
    const url = blobUrl("cid/with?special&chars");
    expect(url).toBe(
      `${PDS_URL}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(OWNER_DID)}&cid=${encodeURIComponent("cid/with?special&chars")}`,
    );
  });
});

describe("cached / bustCache", () => {
  it("returns the cached value within the TTL without calling fn again", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fn = async () => { calls++; return `value-${calls}`; };

    const first = await cached("key-a", 1000, fn);
    const second = await cached("key-a", 1000, fn);

    expect(first).toBe("value-1");
    expect(second).toBe("value-1"); // stale-within-TTL, not refetched
    expect(calls).toBe(1);
  });

  it("refetches once the TTL has elapsed", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fn = async () => { calls++; return `value-${calls}`; };

    const first = await cached("key-b", 1000, fn);
    vi.advanceTimersByTime(1001);
    const second = await cached("key-b", 1000, fn);

    expect(first).toBe("value-1");
    expect(second).toBe("value-2");
    expect(calls).toBe(2);
  });

  it("bustCache() with no prefix clears every key immediately", async () => {
    let calls = 0;
    const fn = async () => { calls++; return `value-${calls}`; };

    await cached("key-c", 60_000, fn);
    bustCache();
    const after = await cached("key-c", 60_000, fn);

    expect(after).toBe("value-2");
    expect(calls).toBe(2);
  });

  it("bustCache(prefix) clears only matching keys", async () => {
    let calls = 0;
    const fn = async () => { calls++; return `value-${calls}`; };

    await cached("photograph:1", 60_000, fn);
    await cached("photograph:2", 60_000, fn);
    await cached("site:self", 60_000, fn);
    bustCache("photograph:");

    const photo1 = await cached("photograph:1", 60_000, fn);
    const photo2 = await cached("photograph:2", 60_000, fn);
    const site = await cached("site:self", 60_000, fn);

    expect(calls).toBe(5); // 3 initial + 2 refetched (bust matched); site untouched
    expect(photo1).toBe("value-4");
    expect(photo2).toBe("value-5");
    expect(site).toBe("value-3"); // untouched by the prefixed bust
  });
});

function rec(rkey: string) {
  return { uri: atUri(rkey), cid: `bafy${rkey}`, value: { title: rkey } };
}

function atUri(rkey: string, collection = "social.opencontent.photograph") {
  return `at://${OWNER_DID}/${collection}/${rkey}`;
}
