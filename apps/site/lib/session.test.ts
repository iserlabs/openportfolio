import { describe, expect, it } from "vitest";
import { isOwnerDid } from "./session";

// getSession()/getIronSessionData() wire iron-session to Next's request-scoped
// cookie store, so they're only meaningfully exercised via the app's routes
// (login page + OAuth callback). The unit-testable business rule is the
// owner derivation: a session is the owner iff its did equals env.OWNER_DID
// exactly -- a single-owner equality check, replacing Luminance's ADMIN_DIDS
// allow-list membership check.
describe("session owner check", () => {
  it("is not owner without a did", () => {
    expect(isOwnerDid(undefined, "did:plc:owner")).toBe(false);
  });
  it("is owner when the did matches OWNER_DID exactly", () => {
    expect(isOwnerDid("did:plc:owner", "did:plc:owner")).toBe(true);
  });
  it("is not owner when the did differs from OWNER_DID", () => {
    expect(isOwnerDid("did:plc:someone-else", "did:plc:owner")).toBe(false);
  });
  it("is not owner when did is a case-different string (dids are compared as opaque strings)", () => {
    expect(isOwnerDid("did:plc:OWNER", "did:plc:owner")).toBe(false);
  });
});
