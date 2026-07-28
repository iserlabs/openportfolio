import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db";
import { blurDataUrls } from "./blur";

describe("blurDataUrls", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("returns an empty map for an empty cid list without touching the db", () => {
    // A poisoned db (closed) would throw on any real query -- proves the
    // empty-input short-circuit never issues one.
    db.close();
    expect(blurDataUrls([], db)).toEqual(new Map());
  });

  it("returns entries only for cids that have a stored blur row", () => {
    db.prepare("INSERT INTO blur (cid, data_url) VALUES (?, ?)").run("cid-a", "data:image/webp;base64,AAA");
    db.prepare("INSERT INTO blur (cid, data_url) VALUES (?, ?)").run("cid-b", "data:image/webp;base64,BBB");

    const result = blurDataUrls(["cid-a", "cid-b", "cid-missing"], db);

    expect(result.get("cid-a")).toBe("data:image/webp;base64,AAA");
    expect(result.get("cid-b")).toBe("data:image/webp;base64,BBB");
    expect(result.has("cid-missing")).toBe(false);
    expect(result.size).toBe(2);
  });

  it("returns an empty map when none of the requested cids have a row", () => {
    db.prepare("INSERT INTO blur (cid, data_url) VALUES (?, ?)").run("cid-a", "data:image/webp;base64,AAA");
    expect(blurDataUrls(["cid-x", "cid-y"], db)).toEqual(new Map());
  });
});
