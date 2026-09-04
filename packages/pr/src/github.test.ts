import { afterEach, describe, expect, it, vi } from "vitest";
import { assignedPrsQuery, fetchPrInfo } from "./github.js";

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

describe("fetchPrInfo", () => {
  const response = {
    title: "t",
    body: null,
    html_url: "https://github.com/acme/widgets/pull/1",
    state: "closed",
    merged: true,
    user: { login: "a" },
    base: { ref: "main", sha: "b", repo: { clone_url: "c" } },
    head: { ref: "f", sha: "h" },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports whether the PR is still open, and whether closing it meant merging", async () => {
    // The watcher removes a PR from the server once it is merged or closed,
    // and this is the only place it can learn that: the search it polls asks
    // for open PRs only, so a merged one has simply vanished from it — as has
    // an approved one, which must stay. The pulls endpoint tells them apart.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response)));
    const info = await fetchPrInfo({ owner: "acme", repo: "widgets", number: 1 });
    expect(info.state).toBe("closed");
    expect(info.merged).toBe(true);
  });
});
