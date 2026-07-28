import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { absoluteImgSrc, imgSrc, imgSrcSet } from "./img-src";

describe("imgSrc", () => {
  it("defaults to the feed preset", () => {
    expect(imgSrc("bafyreicid123")).toBe("/img/bafyreicid123/feed");
  });

  it("builds the URL for an explicit preset", () => {
    expect(imgSrc("bafyreicid123", "thumb")).toBe("/img/bafyreicid123/thumb");
    expect(imgSrc("bafyreicid123", "full")).toBe("/img/bafyreicid123/full");
  });

  it("percent-encodes an adversarial cid", () => {
    expect(imgSrc("cid/with?special&chars")).toBe(`/img/${encodeURIComponent("cid/with?special&chars")}/feed`);
  });
});

describe("imgSrcSet", () => {
  it("spans thumb/grid/feed at their preset widths", () => {
    expect(imgSrcSet("bafyreicid123")).toBe(
      "/img/bafyreicid123/thumb 512w, /img/bafyreicid123/grid 768w, /img/bafyreicid123/feed 1024w",
    );
  });

  it("percent-encodes an adversarial cid", () => {
    const cid = "cid/with?special&chars";
    const encoded = encodeURIComponent(cid);
    expect(imgSrcSet(cid)).toBe(`/img/${encoded}/thumb 512w, /img/${encoded}/grid 768w, /img/${encoded}/feed 1024w`);
  });
});

describe("absoluteImgSrc", () => {
  beforeEach(() => {
    process.env.PUBLIC_URL = "https://portfolio.example.com";
  });
  afterEach(() => {
    delete process.env.PUBLIC_URL;
  });

  it("prefixes the relative imgSrc path with env.PUBLIC_URL", () => {
    expect(absoluteImgSrc("bafyreicid123", "feed")).toBe("https://portfolio.example.com/img/bafyreicid123/feed");
  });

  it("defaults to the feed preset, matching imgSrc's default", () => {
    expect(absoluteImgSrc("bafyreicid123")).toBe("https://portfolio.example.com/img/bafyreicid123/feed");
  });
});
