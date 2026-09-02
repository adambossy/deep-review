import { describe, expect, it } from "vitest";
import { assignedPrsQuery } from "./github.js";

describe("assignedPrsQuery", () => {
  it("asks for open PRs assigned to the token's owner", () => {
    const q = assignedPrsQuery();
    expect(q).toContain("is:open");
    expect(q).toContain("is:pr");
    expect(q).toContain("assignee:@me");
  });

  it("excludes drafts, which are not ready to be read", () => {
    expect(assignedPrsQuery()).toContain("-is:draft");
  });

  it("excludes what has already been approved", () => {
    // Assigned-and-open is not the same as waiting on you: a PR you have
    // already signed off on is done, and re-reviewing it costs a slicing run.
    expect(assignedPrsQuery()).toContain("-review:approved");
  });

  it("watches every visible repo when none is named", () => {
    expect(assignedPrsQuery()).not.toContain("repo:");
  });

  it("scopes to one repo when asked", () => {
    expect(assignedPrsQuery({ repo: "acme/widgets" })).toContain("repo:acme/widgets");
  });

  it("leaves an undefined repo out rather than emitting an empty filter", () => {
    expect(assignedPrsQuery({ repo: undefined })).not.toContain("repo:");
  });
});
