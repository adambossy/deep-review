import { describe, expect, it } from "vitest";
import { renderIndexPage } from "./indexPage.js";
import type { PrView } from "./registry.js";

function view(overrides: Partial<PrView> = {}): PrView {
  return {
    owner: "a",
    repo: "b",
    number: 1,
    key: "a/b#1",
    prUrl: "https://github.com/a/b/pull/1",
    state: "ready",
    path: "/pr/a/b/1/",
    title: "A PR",
    slices: 2,
    graphs: 1,
    addedAt: 0,
    log: [],
    live: false,
    ...overrides,
  };
}

describe("renderIndexPage", () => {
  it("shows a ready PR's size split by kind under its facts", () => {
    const html = renderIndexPage(
      [
        view({
          size: {
            byKind: {
              core: { additions: 120, deletions: 30 },
              test: { additions: 80, deletions: 5 },
              boilerplate: { additions: 0, deletions: 0 },
            },
            total: { additions: 200, deletions: 35 },
          },
        }),
      ],
      "0",
    );
    const row = /<div class="row ready"[\s\S]*?<div class="side-actions">/.exec(html)![0];
    expect(row).toContain("2 slices · 1 with a walkable call graph");
    expect(row).toContain(
      '<span class="kind">core</span> <span class="plus">+120</span><span class="minus">−30</span>',
    );
    expect(row).toContain(
      '<span class="kind">tests</span> <span class="plus">+80</span><span class="minus">−5</span>',
    );
    expect(row).not.toContain("boilerplate");
    // The bar's styles ride along, since the explorer's stylesheet does not.
    expect(html).toContain(".delta .core { --kind-color");
  });

  it("shows one unsplit total for a PR whose report predates kinds", () => {
    const html = renderIndexPage(
      [view({ size: { byKind: null, total: { additions: 7, deletions: 2 } } })],
      "0",
    );
    expect(html).toContain(
      '<span class="delta-kind unclassified"><span class="plus">+7</span><span class="minus">−2</span></span>',
    );
    expect(html).not.toContain('<span class="kind">');
  });

  it("shows no size while a PR is still building, or when it changed nothing", () => {
    const building = renderIndexPage([view({ state: "building", size: undefined })], "0");
    expect(building).not.toContain('class="delta"');
    const empty = renderIndexPage(
      [view({ size: { byKind: null, total: { additions: 0, deletions: 0 } } })],
      "0",
    );
    expect(empty).not.toContain('class="delta"');
  });
});
