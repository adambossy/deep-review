import { describe, expect, it } from "vitest";
import { fileBlockRanges, renderSliceExplorerHtml, type SliceInput } from "./sliceExplorer.js";
import type { CallPathResult, FunctionSnapshot, PathNode } from "./types.js";

function snapshot(file: string, lines: string[]): FunctionSnapshot {
  return {
    file,
    startLine: 1,
    endLine: lines.length,
    callSites: [],
    source: [{ startLine: 1, lines }],
    truncated: false,
  };
}

function node(
  id: string,
  name: string,
  file: string,
  nameLine = 1,
): PathNode {
  return {
    id,
    name,
    file,
    presence: "both",
    before: null,
    after: snapshot(file, ["function " + name + "() {", "}"]),
    hunks: [],
    changedInPr: false,
    expanded: true,
    nameLine,
    nameColumn: 9,
  };
}

const graph: CallPathResult = {
  prUrl: "https://github.com/a/b/pull/1",
  prTitle: "A PR",
  functionName: "retry",
  base: { ref: "main", sha: "a".repeat(40) },
  head: { ref: "pull/1/head", sha: "b".repeat(40) },
  rootId: "a.ts#retry",
  nodes: [
    node("a.ts#retry", "retry", "a.ts", 3),
    node("a.ts#retryDelay", "retryDelay", "a.ts", 50),
  ],
  edges: [],
  files: [],
};

const fragment = {
  id: "a.ts#0@1-3",
  file: "a.ts",
  summary: "calls retry",
  hunkHeader: "@@ -1,2 +1,3 @@",
  lines: [
    " const x = 1;",
    "+retry();",
    "-const retryDelayed = 2;",
    "+function retry() {}",
  ],
  newLineNumbers: [1, 2, null, 3] as (number | null)[],
  headStart: 1,
  headEnd: 3,
};

/** A second fragment in the same file, far enough away to leave a gap. */
const farFragment = {
  id: "a.ts#1@1-1",
  file: "a.ts",
  summary: "later change",
  hunkHeader: "@@ -40,1 +40,1 @@",
  lines: ["+const y = 2;"],
  newLineNumbers: [40] as (number | null)[],
  headStart: 40,
  headEnd: 40,
};

/** The head-side text the file block needs for context and expanders. */
const files = [
  {
    side: "after" as const,
    path: "a.ts",
    lines: Array.from({ length: 60 }, (_, i) => `line ${i + 1};`),
    symbols: [
      {
        name: "Box",
        kind: "class",
        startLine: 1,
        endLine: 45,
        children: [{ name: "open", kind: "method", startLine: 30, endLine: 44 }],
      },
    ],
  },
];

function render(overrides: Partial<SliceInput> = {}): string {
  return renderSliceExplorerHtml({
    prUrl: "https://github.com/a/b/pull/1",
    prTitle: "A PR",
    repo: "a/b",
    number: 1,
    overview: "does a thing",
    files,
    slices: [
      {
        id: "slice-1",
        title: "First",
        summary: "s",
        rationale: "r",
        target: { file: "a.ts", name: "retry" },
        fragments: [fragment, farFragment],
        graph,
        ...overrides,
      },
      {
        id: "slice-2",
        title: "Second",
        summary: "s2",
        rationale: "r2",
        fragments: [fragment],
      },
    ],
  });
}

/** The same page for a PR that has a description, for the description tab. */
const describedHtml = renderSliceExplorerHtml({
  prUrl: "https://github.com/a/b/pull/1",
  prTitle: "A PR",
  repo: "a/b",
  number: 1,
  overview: "does a thing",
  prDescription: "# Why\n\nIt **hoists** `retry` out of the loop.",
  prAuthor: "octocat",
  files,
  slices: [{ id: "slice-1", title: "First", summary: "s", rationale: "r", fragments: [fragment] }],
});

describe("renderSliceExplorerHtml", () => {
  const html = render();

  it("stacks one view per slice", () => {
    expect([...html.matchAll(/class="slice-view"/g)]).toHaveLength(2);
    expect(html).toContain('class="deck"');
  });

  it("gives each slice its own track so the two axes are independent", () => {
    expect([...html.matchAll(/class="track"/g)]).toHaveLength(2);
    // Per-slice defs; the page-level shared-defs is a third, separate block.
    expect([...html.matchAll(/<div class="panel-defs"/g)]).toHaveLength(2);
    expect([...html.matchAll(/id="shared-defs"/g)]).toHaveLength(1);
  });

  it("leaves the diff's symbols to the navigation server: every identifier is an .id span, none pre-targeted", () => {
    const panel = /<article class="panel slice-panel"[\s\S]*?<\/article>/.exec(html)![0];
    expect(panel).toContain('<div class="code-pane" data-file="a.ts" data-side="after">');
    expect(panel).toContain('id">retry</span>');
    expect(panel).not.toContain("data-target");
    // A removed line has no head-side position: nothing to ask about.
    const at = panel.indexOf('<span class="line diff-del">');
    const removed = panel.slice(at, panel.slice(at + 1).search(/<span class="line[ "]/) + at + 1);
    expect(removed).toContain("retryDelayed");
    expect(removed).not.toContain('class="id"');
  });

  it("falls back to any track's panel-defs, so a symbol resolved to another slice's call-graph node still opens", () => {
    // Without this, a tap on a node walked only in a different slice's
    // graph finds nothing in the current track or #shared-defs and does
    // nothing — see panelFor's own lookup order just above.
    expect(html).toContain('document.querySelector(".panel-defs " + sel)');
  });

  it("emits one render-data blob for the whole page", () => {
    expect([...html.matchAll(/id="render-data"/g)]).toHaveLength(1);
  });

  it("renders a slice with no graph, without clickable symbols", () => {
    const second = html.slice(html.indexOf("Second"));
    expect(second).toContain("no call graph");
  });

  it("escapes the per-slice name map so it survives as an attribute", () => {
    expect(html).toContain("data-names=\"{&quot;a.ts#retry&quot;");
  });

  it("renders a file's fragments as one pane, not one box each", () => {
    // Both of slice one's fragments are in a.ts, so they share a pane.
    const panel = /<article class="panel slice-panel"[\s\S]*?<\/article>/.exec(html)![0];
    expect([...panel.matchAll(/class="code-pane"/g)]).toHaveLength(1);
    expect([...panel.matchAll(/class="source"/g)]).toHaveLength(1);
  });

  it("puts nothing between the fragments to break the listing", () => {
    const panel = /<article class="panel slice-panel"[\s\S]*?<\/article>/.exec(html)![0];
    // Neither the fragment ids nor their summaries reach the page.
    expect(panel).not.toContain("a.ts#0@1-3");
    expect(panel).not.toContain("calls retry");
    expect(panel).not.toContain("later change");
    // Only the code rows and the expanders between them.
    const block = /<pre class="source"[\s\S]*?<\/pre>/.exec(panel)![0];
    const rows = [...block.matchAll(/<span class="line( [^"]*)?"/g)].map((m) =>
      (m[1] ?? "").trim(),
    );
    expect(new Set(rows)).toEqual(new Set(["", "diff-add", "diff-del"]));
  });

  it("marks the words that changed inside a paired −/+ line, and nothing when a line was rewritten", () => {
    const pairFragment = {
      ...farFragment,
      id: "a.ts#2@40-41",
      lines: ["-const y = 1;", "+const y = 2;"],
      newLineNumbers: [null, 40] as (number | null)[],
    };
    const paired = render({ fragments: [fragment, pairFragment] });
    expect(paired).toContain('diff-del-inner">1</span>');
    expect(paired).toContain('diff-add-inner">2</span>');
    // `const retryDelayed = 2;` → `function retry() {}` shares only spaces.
    const panel = /<article class="panel slice-panel"[\s\S]*?<\/article>/.exec(paired)![0];
    expect(panel).not.toContain('diff-del-inner">const');
  });

  it("puts an expander over the run hidden between two fragments, labelled with the scope after it", () => {
    // The first fragment ends at line 3 and shows 5 lines after it; the next
    // starts at 40 and shows 5 before it, leaving 9..34 hidden. Line 35 is
    // inside Box.open.
    expect(html).toContain('data-from="9" data-to="34"');
    expect(html).toContain('<span class="gap-crumb">class Box › open()</span>');
  });

  it("heads the pane with the same sticky scope bar every panel uses, plus the file's +/− count", () => {
    const panel = /<article class="panel slice-panel"[\s\S]*?<\/article>/.exec(html)![0];
    expect(panel).toContain('<div class="scope-bar" data-key="after:a.ts"><span class="scope-path"><span class="name">a.ts</span></span>');
    // Line 1 is the first visible line, inside Box.
    expect(panel).toContain('<span class="scope-sym">Box</span>');
    expect(panel).toContain('<span class="stat"><span class="plus">+3</span><span class="minus">−1</span></span>');
    expect(panel).not.toContain("file-block");
  });

  it("shows context around a fragment and an expander over the tail", () => {
    // Five lines of trailing context after the fragment ending at line 3,
    // and nothing beyond it until the next fragment's own context.
    const panel = /<article class="panel slice-panel"[\s\S]*?<\/article>/.exec(html)![0];
    expect(panel).toContain('<span class="lineno"> 8</span>');
    expect(panel).not.toContain('<span class="lineno"> 9</span>');
    expect(panel).toContain('<span class="lineno">35</span>');
    expect(panel).toContain('data-from="46" data-to="60"');
  });
});

describe("fileBlockRanges", () => {
  it("pads each fragment with context and merges touching pads", () => {
    expect(fileBlockRanges([fragment, farFragment], 60)).toEqual([
      [1, 8],
      [35, 45],
    ]);
    const near = { ...farFragment, headStart: 12, headEnd: 12 };
    expect(fileBlockRanges([fragment, near], 60)).toEqual([[1, 17]]);
  });

  it("gives a deletion-only fragment context around the point it sits at", () => {
    const deletion = { ...farFragment, headStart: 40, headEnd: 39, newLineNumbers: [null] };
    expect(fileBlockRanges([deletion], 60)).toEqual([[35, 44]]);
  });
});

describe("renderSliceExplorerHtml navigation hooks", () => {
  const html = render();

  it("ships nothing precomputed: no reference or name blobs, an empty shared-defs", () => {
    expect(html).not.toContain('id="ref-data"');
    expect(html).not.toContain('id="def-names"');
    expect(html).not.toContain("window.REFS");
    expect(html).toContain('<div id="shared-defs" class="panel-defs" hidden></div>');
  });

  it("asks the local server about a symbol, its callers, and its panel when clicked", () => {
    expect(html).toContain('"/definition?file="');
    expect(html).toContain('"/references?id="');
    expect(html).toContain('"/panel?id="');
    expect(html).toContain("e.metaKey || e.ctrlKey");
    expect(html).not.toContain("contextmenu");
    expect(html).toContain("resolving");
    expect(html).not.toContain("more</div>");
  });

  it("keeps the in-place shortcut and tells the server when the page goes", () => {
    expect(html).toContain("inView");
    expect(html).toContain("linkInPlace");
    expect(html).toContain('sendBeacon(navUrl("/gone"))');
    expect(html).toContain('fetch(navUrl("/alive")');
    // Rendered without a navBase — a static copy — the page asks at the root.
    expect(html).toContain('window.NAV_BASE = ""');
  });

  it("offers the description as a second view, with the code selected first", () => {
    expect(html).toContain('<button class="view-tab" role="tab" data-view="slices" aria-selected="true">Slices</button>');
    expect(html).toContain('data-view="description" aria-selected="false">Description</button>');
    // The code view is what the page opens on; the prose waits, hidden.
    expect(html).toContain('<div class="stage" data-view="slices">');
    expect(html).toContain('<section class="doc-view" data-view="description" hidden>');
  });

  it("renders the description as markdown, alongside the model's overview", () => {
    const doc = describedHtml.slice(describedHtml.indexOf('class="doc-view"'));
    expect(doc).toContain(`<h3 class="md-h">Why</h3>`);
    expect(doc).toContain(`<strong>hoists</strong>`);
    expect(doc).toContain(`<code class="md-inline-code">retry</code>`);
    expect(doc).toContain("opened by octocat");
    expect(doc).toContain(`<p class="doc-overview">does a thing</p>`);
  });

  it("says a PR has no description rather than dropping the tab", () => {
    expect(html).toContain('class="doc-empty">This PR has no description.');
    expect(html).toContain('data-view="description"');
  });

  it("ships no debug hints unless asked", () => {
    expect(html).not.toContain("data-why");
    expect(html).not.toContain("debug-legend");
    expect(html).not.toContain("DEBUG_MARKS = true");
    expect(html).not.toContain("body.debug-marks");
  });

  it("with --debug-marks, identifiers say they have not been asked yet and the overlay ships", () => {
    const debug = renderSliceExplorerHtml({
      prUrl: "https://github.com/a/b/pull/1",
      prTitle: "A PR",
      repo: "a/b",
      number: 1,
      overview: "does a thing",
      files,
      debugMarks: true,
      slices: [{ id: "slice-1", title: "First", summary: "s", rationale: "r", fragments: [fragment], graph }],
    });
    expect(debug).toContain('<span class="tok-fn id" data-why="id · not asked yet">retry</span>');
    expect(debug).toContain('id="debug-legend"');
    expect(debug).toContain("window.DEBUG_MARKS = true");
    expect(debug).toContain('e.key === "Shift"');
    expect(debug).toContain("body.debug-marks [data-why]:hover::after");
  });
});
