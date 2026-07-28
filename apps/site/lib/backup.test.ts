import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

    expect(result).toMatchObject({ skipped: false, ok: true, blobsWritten: 2, blobsSkipped: 0, blobsFailed: 0 });
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

    // Atomic write: no .tmp litter left behind once a run completes cleanly.
    const carEntries = await readdir(path.join(dir, "car"));
    expect(carEntries).toEqual(["2026-07-28.car"]);
    const blobEntries = (await readdir(path.join(dir, "blobs"))).sort();
    expect(blobEntries).toEqual(["bafy-one", "bafy-two"]);
  });

  it("skips a blob that already exists on disk, without ever calling fetchBlob for it", async () => {
    await mkdirBlobs(dir);
    await writeFile(path.join(dir, "blobs", "bafy-existing"), "already-here");

    const fetchCar = vi.fn(async () => new Response(new Uint8Array([1])));
    const fetchJson = vi.fn(async () => ({ cids: ["bafy-existing", "bafy-new"] }));
    const fetchBlob = vi.fn(async () => Buffer.from([42]));

    const result = await runBackup(deps({ fetchCar, fetchJson, fetchBlob }));

    expect(result).toMatchObject({ blobsWritten: 1, blobsSkipped: 1, blobsFailed: 0 });
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

  it("counts (and logs, never writes) a cid containing path-traversal characters as a failed blob, without aborting the run", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchCar = vi.fn(async () => new Response(new Uint8Array([1])));
    const fetchJson = vi.fn(async () => ({ cids: ["../../etc/passwd", "bafy-safe"] }));
    const fetchBlob = vi.fn(async () => Buffer.from([1]));

    const result = await runBackup(deps({ fetchCar, fetchJson, fetchBlob }));

    expect(result).toMatchObject({ skipped: false, ok: true, blobsWritten: 1, blobsFailed: 1 });
    expect(fetchBlob).toHaveBeenCalledTimes(1);
    expect(fetchBlob).toHaveBeenCalledWith("bafy-safe");
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("blob"), expect.stringContaining("unsafe cid"));
  });

  it("isolates a single failed blob fetch: logs it, keeps blobsFailed, and still writes the rest", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchCar = vi.fn(async () => new Response(new Uint8Array([1])));
    const fetchJson = vi.fn(async () => ({ cids: ["bafy-good-1", "bafy-bad", "bafy-good-2"] }));
    const fetchBlob = vi.fn(async (cid: string) => {
      if (cid === "bafy-bad") throw new Error("getBlob 502");
      return Buffer.from([1]);
    });

    const result = await runBackup(deps({ fetchCar, fetchJson, fetchBlob }));

    expect(result).toMatchObject({ skipped: false, ok: true, blobsWritten: 2, blobsSkipped: 0, blobsFailed: 1 });
    expect(fetchBlob).toHaveBeenCalledTimes(3); // the bad cid didn't stop the other two from being attempted
    await expect(readFile(path.join(dir, "blobs", "bafy-good-1"))).resolves.toBeDefined();
    await expect(readFile(path.join(dir, "blobs", "bafy-good-2"))).resolves.toBeDefined();
    await expect(readFile(path.join(dir, "blobs", "bafy-bad"))).rejects.toThrow();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("bafy-bad"), expect.stringContaining("502"));
  });

  it("writes the CAR atomically: a mid-stream upstream failure leaves no file at the final path and no .tmp litter", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3])); // some bytes land before the failure
        controller.error(new Error("connection reset mid-transfer"));
      },
    });
    const fetchCar = vi.fn(async () => new Response(failingStream));

    const result = await runBackup(deps({ fetchCar }));

    expect(result).toMatchObject({ skipped: false, ok: false, error: expect.stringContaining("connection reset") });
    await expect(readFile(path.join(dir, "car", "2026-07-28.car"))).rejects.toThrow();
    const carEntries = await readdir(path.join(dir, "car"));
    expect(carEntries).toEqual([]); // the .tmp file was cleaned up, not left behind
    expect(consoleError).toHaveBeenCalled();
  });

  it("returns {skipped:true} and touches no dep at all when BACKUP_DIR is unset", async () => {
    delete process.env.BACKUP_DIR;
    const fetchCar = vi.fn();
    const fetchJson = vi.fn();
    const fetchBlob = vi.fn();

    const result = await runBackup({ fetchCar, fetchJson, fetchBlob });

    expect(result).toEqual({ skipped: true });
    expect(fetchCar).not.toHaveBeenCalled();
    expect(fetchJson).not.toHaveBeenCalled();
    expect(fetchBlob).not.toHaveBeenCalled();
  });

  it("logs and returns a failure result instead of throwing when the upstream CAR fetch fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchCar = vi.fn(async () => {
      throw new Error("pds unreachable");
    });

    const result = await runBackup(deps({ fetchCar }));

    expect(result).toEqual({ skipped: false, ok: false, error: "pds unreachable" });
    expect(consoleError).toHaveBeenCalled();
  });
});

async function mkdirBlobs(dir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(dir, "blobs"), { recursive: true });
}
