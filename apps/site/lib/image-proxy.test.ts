import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { PhotographRecord } from "@openportfolio/lexicons";
import { openDb } from "./db";
import { assemblePortfolio, type Portfolio } from "./portfolio";
import type { RecordEnvelope } from "./pds";
import { proxyImage } from "./image-proxy";

const OWNER_DID = "did:plc:owner";

// Mirrors lib/portfolio.test.ts's photoEnv helper -- builds a real
// RecordEnvelope<PhotographRecord> so `assemblePortfolio` (the actual
// production assembly function, not a hand-rolled stand-in) produces the
// Portfolio these tests exercise `proxyImage`'s allowlist against.
function photoEnv(rkey: string, cid: string): RecordEnvelope<PhotographRecord> {
  return {
    uri: `at://${OWNER_DID}/social.opencontent.photograph/${rkey}`,
    cid: `recordcid-${rkey}`,
    value: {
      $type: "social.opencontent.photograph",
      image: { $type: "blob", ref: { $link: cid }, mimeType: "image/jpeg", size: 100 },
      aspectRatio: { width: 4, height: 3 },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function portfolioWith(cids: string[]): Portfolio {
  const envelopes = cids.map((cid, i) => photoEnv(`p${i}`, cid));
  return assemblePortfolio(null, [], envelopes);
}

function testDb(): Database.Database {
  return openDb(":memory:");
}

describe("proxyImage", () => {
  it("404s for a blob cid the portfolio does not reference -- before any fetch", async () => {
    const db = testDb();
    let fetched = false;
    const res = await proxyImage(
      db,
      { cid: "bafk-unknown", preset: "feed", accept: "image/webp" },
      {
        getPortfolio: async () => portfolioWith(["bafk-photo"]),
        fetchBlob: async () => {
          fetched = true;
          return Buffer.alloc(0);
        },
      },
    );
    expect(res.status).toBe(404);
    expect(res.cacheControl).toBe("public, max-age=300");
    expect(fetched).toBe(false);
  });

  it("400s on an unknown preset", async () => {
    const db = testDb();
    const res = await proxyImage(
      db,
      { cid: "bafk-photo", preset: "original" as never, accept: "" },
      { getPortfolio: async () => portfolioWith(["bafk-photo"]) },
    );
    expect(res.status).toBe(400);
  });

  it("400s on a prototype-pollution preset (constructor) rather than resolving an inherited member", async () => {
    const db = testDb();
    const res = await proxyImage(
      db,
      { cid: "bafk-photo", preset: "constructor" as never, accept: "" },
      { getPortfolio: async () => portfolioWith(["bafk-photo"]) },
    );
    expect(res.status).toBe(400);
  });

  it("serves an allowlisted blob resized to the preset width, with an immutable cache header", async () => {
    const db = testDb();
    const sharp = (await import("sharp")).default;
    const src = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: "#333" } })
      .jpeg()
      .toBuffer();
    const res = await proxyImage(
      db,
      { cid: "bafk-photo", preset: "feed", accept: "image/webp" },
      { getPortfolio: async () => portfolioWith(["bafk-photo"]), fetchBlob: async () => src },
    );
    expect(res.status).toBe(200);
    expect(res.cacheControl).toBe("public, max-age=31536000, immutable");
    const meta = await sharp(res.body!).metadata();
    expect(meta.width).toBe(1024);
  });

  it("content-negotiates avif/webp/jpeg from the Accept header", async () => {
    const db = testDb();
    const sharp = (await import("sharp")).default;
    const src = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#333" } })
      .jpeg()
      .toBuffer();
    const deps = { getPortfolio: async () => portfolioWith(["bafk-photo"]), fetchBlob: async () => src };

    const avif = await proxyImage(db, { cid: "bafk-photo", preset: "thumb", accept: "image/avif,image/*" }, deps);
    expect(avif.contentType).toBe("image/avif");

    const webp = await proxyImage(db, { cid: "bafk-photo", preset: "thumb", accept: "image/webp" }, deps);
    expect(webp.contentType).toBe("image/webp");

    const jpeg = await proxyImage(db, { cid: "bafk-photo", preset: "thumb", accept: "text/html" }, deps);
    expect(jpeg.contentType).toBe("image/jpeg");
  });

  it("502s with a 30s negative cache when the PDS fetch fails", async () => {
    const db = testDb();
    const res = await proxyImage(
      db,
      { cid: "bafk-photo", preset: "feed", accept: "" },
      {
        getPortfolio: async () => portfolioWith(["bafk-photo"]),
        fetchBlob: async () => {
          throw new Error("pds down");
        },
      },
    );
    expect(res.status).toBe(502);
    expect(res.cacheControl).toBe("public, max-age=30");
  });

  it("populates the blur table's data_url on the first successful serve", async () => {
    const db = testDb();
    const sharp = (await import("sharp")).default;
    const src = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#a35" } })
      .jpeg()
      .toBuffer();
    const res = await proxyImage(
      db,
      { cid: "bafk-photo", preset: "thumb", accept: "image/webp" },
      { getPortfolio: async () => portfolioWith(["bafk-photo"]), fetchBlob: async () => src },
    );
    expect(res.status).toBe(200);

    const row = db.prepare("SELECT data_url FROM blur WHERE cid = ?").get("bafk-photo") as
      | { data_url: string }
      | undefined;
    expect(row?.data_url).toMatch(/^data:image\/webp;base64,/);
    // Tiny by construction -- inlined into every feed page, so keep it honest.
    expect(row!.data_url.length).toBeLessThan(1500);
    const meta = await sharp(Buffer.from(row!.data_url.split(",")[1], "base64")).metadata();
    expect(meta.width).toBe(16);
  });

  it("does not overwrite an existing blur data_url", async () => {
    const db = testDb();
    db.prepare("INSERT INTO blur (cid, data_url) VALUES (?, ?)").run(
      "bafk-photo",
      "data:image/webp;base64,SENTINEL",
    );
    const sharp = (await import("sharp")).default;
    const src = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#a35" } })
      .jpeg()
      .toBuffer();
    const res = await proxyImage(
      db,
      { cid: "bafk-photo", preset: "thumb", accept: "" },
      { getPortfolio: async () => portfolioWith(["bafk-photo"]), fetchBlob: async () => src },
    );
    expect(res.status).toBe(200);

    const row = db.prepare("SELECT data_url FROM blur WHERE cid = ?").get("bafk-photo") as { data_url: string };
    expect(row.data_url).toBe("data:image/webp;base64,SENTINEL");
  });
});
