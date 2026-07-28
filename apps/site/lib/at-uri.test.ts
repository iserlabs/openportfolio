import { describe, expect, it } from "vitest";
import { rkeyFromUri } from "./at-uri";

describe("rkeyFromUri", () => {
  it("extracts the trailing record key from an at:// uri", () => {
    expect(rkeyFromUri("at://did:plc:owner/social.opencontent.photograph/abc123")).toBe("abc123");
  });

  it("extracts 'self' for the singleton site record", () => {
    expect(rkeyFromUri("at://did:plc:owner/social.opencontent.site/self")).toBe("self");
  });

  it("throws on a uri with a trailing slash (empty rkey)", () => {
    expect(() => rkeyFromUri("at://did:plc:owner/social.opencontent.collection/")).toThrow();
  });

  it("throws on an empty string", () => {
    expect(() => rkeyFromUri("")).toThrow();
  });
});
