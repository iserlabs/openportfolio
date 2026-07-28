import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../lib/session", () => ({ requireOwner: vi.fn() }));
vi.mock("../../../../lib/photo-metadata", () => ({ extractPrefill: vi.fn() }));

import { extractPrefill } from "../../../../lib/photo-metadata";
import { requireOwner } from "../../../../lib/session";
import { POST } from "./route";

function makeRequest(file: File | null): Request {
  const fd = new FormData();
  if (file) fd.set("file", file);
  return new Request("http://localhost/admin/api/prefill", { method: "POST", body: fd });
}

function makeImageFile(): File {
  return new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" });
}

describe("POST /admin/api/prefill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a non-owner with 403 before ever touching extractPrefill", async () => {
    vi.mocked(requireOwner).mockRejectedValueOnce(new Error("owner only"));

    const res = await POST(makeRequest(makeImageFile()));

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(extractPrefill).not.toHaveBeenCalled();
  });

  it("returns 400 when no file is present", async () => {
    vi.mocked(requireOwner).mockResolvedValueOnce("did:plc:owner");

    const res = await POST(makeRequest(null));

    expect(res.status).toBe(400);
    expect(extractPrefill).not.toHaveBeenCalled();
  });

  it("returns the prefill JSON on success", async () => {
    vi.mocked(requireOwner).mockResolvedValueOnce("did:plc:owner");
    const prefill = { tags: [], exif: {}, width: 10, height: 20, hasGps: false };
    vi.mocked(extractPrefill).mockResolvedValueOnce(prefill);

    const res = await POST(makeRequest(makeImageFile()));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, prefill });
  });

  it("maps an extractPrefill throw to a 422 carrying its own message", async () => {
    vi.mocked(requireOwner).mockResolvedValueOnce("did:plc:owner");
    vi.mocked(extractPrefill).mockRejectedValueOnce(new Error("this build cannot decode HEIC"));

    const res = await POST(makeRequest(makeImageFile()));

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json).toEqual({ ok: false, error: "this build cannot decode HEIC" });
  });

  it("rejects files larger than 32 MB with 413 before calling extractPrefill", async () => {
    vi.mocked(requireOwner).mockResolvedValueOnce("did:plc:owner");
    const largeFile = new File([new Uint8Array(33 * 1024 * 1024)], "huge.jpg", { type: "image/jpeg" });

    const res = await POST(makeRequest(largeFile));

    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json).toEqual({ ok: false, error: "file too large for prefill" });
    expect(extractPrefill).not.toHaveBeenCalled();
  });
});
