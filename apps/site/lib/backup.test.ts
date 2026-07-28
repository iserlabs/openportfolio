import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BackupDeps, runBackup } from "./backup";

const OWNER_DID = "did:plc:owner";
const PDS_URL = "https://pds.example.com";

describe("runBackup", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "backup-test-"));
    process.env.BACKUP_DIR = dir;
    process.env.PDS_URL = PDS_URL;
    process.env.OWNER_DID = OWNER_DID;
  });

  afterEach(async () => {
    delete process.env.BACKUP_DIR;
    delete process.env.PDS_URL;
    delete process.env.OWNER_DID;
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function deps(overrides: BackupDeps = {}): BackupDeps {
    return {
      now: () => new Date("2026-07-28T03:00:00.000Z"),
      pruneOauthStates: vi.fn().mockReturnValue(0),
      ...overrides,
    };
  }

  it("writes the CAR file and every listed blob on a happy-path run", async () => {
    const carBytes = new Uint8Array([1, 2, 3, 4]);
    const blobBytes: Record<string, Uint8Array> = {
      "bafy-one": new Uint8Array([9, 9]),
      "bafy-two": new Uint8Array([7, 7, 7]),
    };
    const fetchCar = vi.fn(async () => new Response(carBytes));
    const fetchJson = vi.fn(async () => ({ cids: Object.keys(blobBytes) }));
    const fetchBlob = vi.fn(async (cid: string) => Buffer.from(blobBytes[cid]));

    const result = await runBackup(deps({ fetchCar, fetchJson, fetchBlob }));

    expect(result).toMatchObject({ skipped: false, ok: true, blobsWritten: 2, blobsSkipped: 0 });
    if (result.skipped || !result.ok) throw new Error("expected success");

    expect(result.carPath).toBe(path.join(dir, "car", "2026-07-28.car"));
    await expect(readFile(result.carPath)).resolves.toEqual(Buffer.from(carBytes));

    for (const [cid, bytes] of Object.entries(blobBytes)) {
      await expect(readFile(path.join(dir, "blobs", cid))).resolves.toEqual(Buffer.from(bytes));
    }

    // fetchCar is called against the pinned repoCarUrl, not a caller-supplied origin.
    expect(fetchCar).toHaveBeenCalledWith(
      `${PDS_URL}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(OWNER_DID)}`,
    );
  });

  it("skips a blob that already exists on disk, without ever calling fetchBlob for it", async () => {
    await mkdirBlobs(dir);
    await writeFile(path.join(dir, "blobs", "bafy-existing"), "already-here");

    const fetchCar = vi.fn(async () => new Response(new Uint8Array([1])));
    const fetchJson = vi.fn(async () => ({ cids: ["bafy-existing", "bafy-new"] }));
    const fetchBlob = vi.fn(async () => Buffer.from([42]));

    const result = await runBackup(deps({ fetchCar, fetchJson, fetchBlob }));

    expect(result).toMatchObject({ blobsWritten: 1, blobsSkipped: 1 });
    expect(fetchBlob).toHaveBeenCalledTimes(1);
    expect(fetchBlob).toHaveBeenCalledWith("bafy-new");
    // The pre-existing file's content is left untouched, not overwritten.
    await expect(readFile(path.join(dir, "blobs", "bafy-existing"), "utf8")).resolves.toBe("already-here");
  });

  it("pages listBlobs by cursor until a page omits one, collecting cids from every page", async () => {
    const fetchCar = vi.fn(async () => new Response(new Uint8Array([1])));
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cids: ["bafy-a", "bafy-b"], cursor: "page2" })
      .mockResolvedValueOnce({ cids: ["bafy-c"] });
    const fetchBlob = vi.fn(async () => Buffer.from([1]));

    const result = await runBackup(deps({ fetchCar, fetchJson, fetchBlob }));

    expect(result).toMatchObject({ blobsWritten: 3, blobsSkipped: 0 });
    expect(fetchJson).toHaveBeenCalledTimes(2);
    const secondCallUrl = fetchJson.mock.calls[1][0] as string;
    expect(secondCallUrl).toContain("cursor=page2");
    const firstCallUrl = fetchJson.mock.calls[0][0] as string;
    expect(firstCallUrl).not.toContain("cursor=");
  });

  it("skips (and logs, never writes) a cid containing path-traversal characters", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchCar = vi.fn(async () => new Response(new Uint8Array([1])));
    const fetchJson = vi.fn(async () => ({ cids: ["../../etc/passwd", "bafy-safe"] }));
    const fetchBlob = vi.fn(async () => Buffer.from([1]));

    const result = await runBackup(deps({ fetchCar, fetchJson, fetchBlob }));

    expect(result).toMatchObject({ skipped: false, ok: true, blobsWritten: 1 });
    expect(fetchBlob).toHaveBeenCalledTimes(1);
    expect(fetchBlob).toHaveBeenCalledWith("bafy-safe");
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("unsafe cid"));
  });

  it("returns {skipped:true} and touches no dep at all when BACKUP_DIR is unset", async () => {
    delete process.env.BACKUP_DIR;
    const fetchCar = vi.fn();
    const fetchJson = vi.fn();
    const fetchBlob = vi.fn();
    const pruneOauthStates = vi.fn();

    const result = await runBackup({ fetchCar, fetchJson, fetchBlob, pruneOauthStates });

    expect(result).toEqual({ skipped: true });
    expect(fetchCar).not.toHaveBeenCalled();
    expect(fetchJson).not.toHaveBeenCalled();
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(pruneOauthStates).not.toHaveBeenCalled();
  });

  it("logs and returns a failure result instead of throwing when the upstream CAR fetch fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const pruneOauthStates = vi.fn();
    const fetchCar = vi.fn(async () => {
      throw new Error("pds unreachable");
    });

    const result = await runBackup(deps({ fetchCar, pruneOauthStates }));

    expect(result).toEqual({ skipped: false, ok: false, error: "pds unreachable" });
    expect(consoleError).toHaveBeenCalled();
    expect(pruneOauthStates).not.toHaveBeenCalled();
  });

  it("calls pruneOauthStates(1h) exactly once, only at the end of a successful tick", async () => {
    const pruneOauthStates = vi.fn().mockReturnValue(3);
    const fetchCar = vi.fn(async () => new Response(new Uint8Array([1])));
    const fetchJson = vi.fn(async () => ({ cids: [] }));

    const result = await runBackup(deps({ fetchCar, fetchJson, pruneOauthStates }));

    expect(result).toMatchObject({ skipped: false, ok: true });
    expect(pruneOauthStates).toHaveBeenCalledTimes(1);
    expect(pruneOauthStates).toHaveBeenCalledWith(60 * 60 * 1000);
  });
});

async function mkdirBlobs(dir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(dir, "blobs"), { recursive: true });
}
