import { afterEach, describe, expect, it, vi } from "vitest";
import { assignedPrsQuery, DEFAULT_REVIEW_QUERY, fetchPrInfo, namesRepo } from "./github.js";

describe("assignedPrsQuery", () => {
  const acme = { repo: "acme/widgets" };

  it("asks for open PRs assigned to the token's owner", () => {
    const q = assignedPrsQuery(acme);
    expect(q).toContain("is:open");
    expect(q).toContain("is:pr");
    expect(q).toContain("assignee:@me");
  });

  it("excludes drafts, which are not ready to be read", () => {
    expect(assignedPrsQuery(acme)).toContain("-is:draft");
  });

  it("excludes what has already been approved", () => {
    // Assigned-and-open is not the same as waiting on you: a PR you have
    // already signed off on is done, and re-reviewing it costs a slicing run.
    expect(assignedPrsQuery(acme)).toContain("-review:approved");
  });

  it("always scopes to the repo it was given", () => {
    // There is no unscoped form. A search with no repo: returns every PR
    // the token can see, and once handed the watcher six PRs from a repo
    // nobody meant to watch; the option is required so that cannot recur.
    expect(assignedPrsQuery(acme)).toContain("repo:acme/widgets");
    expect(assignedPrsQuery(acme)).toBe(`${DEFAULT_REVIEW_QUERY} repo:acme/widgets`);
  });

  it("takes a repo's own clauses in place of the default ones", () => {
    const q = assignedPrsQuery({ repo: "acme/widgets", query: "is:open is:pr review-requested:@me" });
    expect(q).toBe("is:open is:pr review-requested:@me repo:acme/widgets");
    expect(q).not.toContain("assignee:@me");
  });

  it("appends the repo from the option, never from the clauses", () => {
    // Two repo: qualifiers in one GitHub search widen it to both repos, so a
    // configured query that named a repo could quietly watch a second one.
    // The repo is the entry's business; a query that claims one is refused.
    expect(() => assignedPrsQuery({ repo: "acme/widgets", query: "is:open repo:acme/other" })).toThrow(
      /names a repo/,
    );
    expect(() => assignedPrsQuery({ repo: "acme/widgets", query: "is:open -repo:acme/other" })).toThrow();
  });

  it("does not mistake a word ending in repo: for the qualifier", () => {
    expect(namesRepo("is:open label:monorepo:fix")).toBe(false);
    expect(namesRepo("repo:x")).toBe(true);
    expect(namesRepo("is:open REPO:x")).toBe(true);
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
