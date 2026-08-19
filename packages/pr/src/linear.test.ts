import { describe, expect, it } from "vitest";
import { extractIssueIdentifiers } from "./linear.js";

describe("extractIssueIdentifiers", () => {
  it("finds identifiers in Linear URLs", () => {
    expect(
      extractIssueIdentifiers(
        "Fixes https://linear.app/acme/issue/ENG-123/retry-budget",
      ),
    ).toEqual(["ENG-123"]);
  });

  it("finds bare mentions and the branch name", () => {
    expect(
      extractIssueIdentifiers("Part of ENG-7.", "", "adam/ENG-8-cleanup"),
    ).toEqual(["ENG-7", "ENG-8"]);
  });

  it("deduplicates across forms, keeping first appearance order", () => {
    expect(
      extractIssueIdentifiers(
        "See PLAT-42 and https://linear.app/acme/issue/ENG-9/x, also ENG-9 again.",
      ),
    ).toEqual(["ENG-9", "PLAT-42"]);
  });

  it("ignores lookalikes that are not team keys", () => {
    expect(
      extractIssueIdentifiers("Encode as UTF-8 per RFC-7231, fixes CVE-2024."),
    ).toEqual([]);
  });

  it("ignores identifiers embedded in longer tokens", () => {
    expect(extractIssueIdentifiers("the ENG-8x build and X-ENG-2")).toEqual([]);
  });
});
