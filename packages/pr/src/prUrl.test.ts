import { describe, expect, it } from "vitest";
import { parsePrUrl } from "./prUrl.js";

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
