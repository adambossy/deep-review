import { describe, expect, it } from "vitest";
import { parsePrTarget, parsePrUrl, prUrl } from "./prUrl.js";

describe("parsePrUrl", () => {
  it("parses a plain PR URL", () => {
    expect(parsePrUrl("https://github.com/vercel/swr/pull/2950")).toEqual({
      owner: "vercel",
      repo: "swr",
      number: 2950,
    });
  });

  it("tolerates trailing paths like /files", () => {
    expect(parsePrUrl("https://github.com/a/b/pull/7/files#diff-x").number).toBe(7);
  });

  it("rejects non-PR URLs", () => {
    expect(() => parsePrUrl("https://github.com/a/b/issues/7")).toThrow(
      /Not a GitHub PR URL/,
    );
    expect(() => parsePrUrl("https://gitlab.com/a/b/pull/7")).toThrow();
  });
});

describe("parsePrTarget", () => {
  it("takes a bare number against a default repo", () => {
    expect(parsePrTarget("10511", "spara-ai/spara-app")).toEqual({
      owner: "spara-ai",
      repo: "spara-app",
      number: 10511,
    });
    expect(parsePrTarget("#7", "a/b").number).toBe(7);
  });

  it("still takes a full URL, ignoring the default repo", () => {
    expect(parsePrTarget("https://github.com/vercel/swr/pull/2950", "a/b")).toEqual({
      owner: "vercel",
      repo: "swr",
      number: 2950,
    });
  });

  it("rejects a bare number with no repo", () => {
    expect(() => parsePrTarget("10511")).toThrow(/needs a repo/);
  });

  it("rejects a malformed default repo", () => {
    expect(() => parsePrTarget("10511", "spara-app")).toThrow(/owner>\/<repo/);
  });
});

describe("prUrl", () => {
  it("round-trips a ref", () => {
    const url = "https://github.com/vercel/swr/pull/2950";
    expect(prUrl(parsePrUrl(url))).toBe(url);
  });
});
