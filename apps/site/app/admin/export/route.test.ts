import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/session", () => ({ requireOwner: vi.fn() }));
vi.mock("../../../lib/backup", () => ({ fetchRepoCar: vi.fn() }));

import { fetchRepoCar } from "../../../lib/backup";
import { requireOwner } from "../../../lib/session";
import { GET } from "./route";

describe("GET /admin/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a non-owner with 403 before ever calling fetchRepoCar (owner-gate-first)", async () => {
    vi.mocked(requireOwner).mockRejectedValueOnce(new Error("owner only"));

    const res = await GET();

    expect(res.status).toBe(403);
    expect(fetchRepoCar).not.toHaveBeenCalled();
  });

  it("streams the upstream body through unmodified -- the response body IS the stub stream, never buffered", async () => {
    vi.mocked(requireOwner).mockResolvedValueOnce("did:plc:owner");
    const stubUpstream = new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 });
    vi.mocked(fetchRepoCar).mockResolvedValueOnce(stubUpstream);

    const res = await GET();

    expect(res.status).toBe(200);
    // Identity check, not a byte-equality check: if the route had buffered
    // the upstream body (e.g. via `.arrayBuffer()`/`.blob()` and rebuilt a
    // new body from that), `res.body` would be a *different* stream object,
    // not this exact one.
    expect(res.body).toBe(stubUpstream.body);
  });

  it("sets the CAR content type and a dated attachment filename", async () => {
    vi.mocked(requireOwner).mockResolvedValueOnce("did:plc:owner");
    const stubUpstream = new Response(new Uint8Array([1]), { status: 200 });
    vi.mocked(fetchRepoCar).mockResolvedValueOnce(stubUpstream);

    const res = await GET();

    expect(res.headers.get("Content-Type")).toBe("application/vnd.ipld.car");
    const today = new Date().toISOString().slice(0, 10);
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="portfolio-${today}.car"`);
  });

  it("502s when the upstream responds with a non-ok status, without throwing", async () => {
    vi.mocked(requireOwner).mockResolvedValueOnce("did:plc:owner");
    vi.mocked(fetchRepoCar).mockResolvedValueOnce(new Response(null, { status: 500 }));

    const res = await GET();

    expect(res.status).toBe(502);
  });

  it("502s (instead of an unhandled throw) when fetchRepoCar itself rejects", async () => {
    vi.mocked(requireOwner).mockResolvedValueOnce("did:plc:owner");
    vi.mocked(fetchRepoCar).mockRejectedValueOnce(new Error("network error / timeout"));

    const res = await GET();

    expect(res.status).toBe(502);
  });
});
