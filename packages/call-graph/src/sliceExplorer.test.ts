import { describe, expect, it } from "vitest";
import { fileBlockRanges, renderSliceExplorerHtml, type SliceInput } from "./sliceExplorer.js";
import type { CallPathResult, FunctionSnapshot, NavigationData, PathNode } from "./types.js";

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

  it("makes graph symbols in the diff tappable", () => {
    expect(html).toContain('data-target="a.ts#retry"');
  });

  it("falls back to any track's panel-defs, so a symbol resolved to another slice's call-graph node still opens", () => {
    // Without this, a tap on a node walked only in a different slice's
    // graph finds nothing in the current track or #shared-defs and does
    // nothing — see panelFor's own lookup order just above.
    expect(html).toContain('document.querySelector(".panel-defs " + sel)');
  });

  it("matches whole words only, so retryDelayed is not a call to retry", () => {
    const panel = /<article class="panel slice-panel"[\s\S]*?<\/article>/.exec(html)![0];
    expect([...panel.matchAll(/data-target="a\.ts#retry"/g)]).toHaveLength(1);
  });

  it("does not make a function's own declaration tappable", () => {
    const panel = /<article class="panel slice-panel"[\s\S]*?<\/article>/.exec(html)![0];
    const rows = panel.split('<span class="line').slice(1);
    const declRows = rows.filter((r) => r.includes("function"));
    const markedRows = rows.filter((r) => r.includes('data-target="a.ts#retry"'));
    // The call to retry is tappable...
    expect(markedRows).toHaveLength(1);
    // ...and the line declaring it is not, though the name is right there.
    expect(declRows).toHaveLength(1);
    expect(declRows[0]).toContain("retry");
    expect(declRows[0]).not.toContain("data-target");
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

describe("renderSliceExplorerHtml with navigation data", () => {
  // `retry()` at line 2 resolves to a definition in b.ts; `x` at line 1 is a
  // local whose declaration is the same line (a self-reference is not linked
  // by the resolver, so the fixture has none for it).
  const nav: NavigationData = {
    links: {
      "a.ts": [
        { line: 1, start: 6, end: 7, def: "a.ts:60:6" },
        { line: 40, start: 6, end: 7, def: "a.ts:60:6" },
        { line: 41, start: 0, end: 4, def: "d-nopanel" },
      ],
    },
    definitions: {
      "a.ts:60:6": {
        id: "a.ts:60:6",
        name: "y",
        kind: "const",
        file: "a.ts",
        external: false,
        nameLine: 60,
        nameColumn: 6,
        nameEndColumn: 7,
        startLine: 60,
        endLine: 60,
        panel: true,
      },
      "a.ts#retry": {
        id: "a.ts#retry",
        name: "retry",
        kind: "function",
        file: "a.ts",
        external: false,
        nameLine: 3,
        nameColumn: 9,
        nameEndColumn: 14,
        startLine: 3,
        endLine: 3,
        panel: true,
        nodeId: "a.ts#retry",
      },
      "d-nopanel": {
        id: "d-nopanel",
        name: "z",
        kind: "variable",
        file: "a.ts",
        external: false,
        nameLine: 55,
        nameColumn: 6,
        nameEndColumn: 7,
        startLine: 55,
        endLine: 55,
        panel: false,
      },
      "ext:/usr/lib/node_modules/typescript/lib/lib.es5.d.ts:100:14": {
        id: "ext:/usr/lib/node_modules/typescript/lib/lib.es5.d.ts:100:14",
        name: "Math",
        kind: "var",
        file: "/usr/lib/node_modules/typescript/lib/lib.es5.d.ts",
        external: true,
        nameLine: 100,
        nameColumn: 14,
        nameEndColumn: 18,
        startLine: 100,
        endLine: 100,
        panel: true,
        source: { startLine: 95, lines: Array.from({ length: 11 }, (_, i) => `// lib line ${95 + i}`) },
      },
    },
    references: {
      "a.ts:60:6": {
        kind: "references",
        total: 12,
        sites: [
          {
            file: "a.ts",
            line: 40,
            startColumn: 6,
            endColumn: 7,
            snippet: "const y = 2;",
            enclosingName: "retry",
            panelId: "a.ts#retry",
          },
        ],
      },
    },
  };

  const page = (debugMarks: boolean, extra: Partial<NavigationData> = {}) => renderSliceExplorerHtml({
    prUrl: "https://github.com/a/b/pull/1",
    prTitle: "A PR",
    repo: "a/b",
    number: 1,
    overview: "does a thing",
    files,
    nav: { ...nav, ...extra },
    ...(debugMarks ? { debugMarks } : {}),
    slices: [
      {
        id: "slice-1",
        title: "First",
        summary: "s",
        rationale: "r",
        target: { file: "a.ts", name: "retry" },
        fragments: [fragment, farFragment],
        graph,
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
  const html = page(false);

  it("marks resolved symbols as tappable with their definition panel id", () => {
    expect(html).toContain('class="sym" data-target="def:a.ts:60:6" data-def="a.ts:60:6"');
  });

  it("marks a definition without a panel by id only, with no target", () => {
    expect(html).toContain('class="sym" data-def="d-nopanel"');
    expect(html).not.toContain('data-node="def:d-nopanel"');
  });

  it("emits each synthesized definition panel once, page-wide", () => {
    const shared = /<div id="shared-defs"[\s\S]*?<\/div>\s*<script/.exec(html)![0];
    expect([...shared.matchAll(/data-node="def:a\.ts:60:6"/g)]).toHaveLength(1);
    expect([...html.matchAll(/data-node="def:a\.ts:60:6"/g)]).toHaveLength(1);
  });

  it("tags the declaration line with the definition id", () => {
    expect(html).toContain('self-sym" data-decl="a.ts:60:6"');
  });

  it("does not synthesize a panel for a definition that is a graph node", () => {
    expect(html).not.toContain('data-node="def:a.ts#retry"');
  });

  it("renders an external definition from its window, labelled external", () => {
    const panel = /<article class="panel" data-node="def:ext:[\s\S]*?<\/article>/.exec(html)![0];
    expect(panel).toContain("external");
    expect(panel).toContain("<code>lib.es5.d.ts:100–100</code>");
    expect(/<h3>[\s\S]*?<\/div>/.exec(panel)![0]).not.toContain("/usr/lib/node_modules");
    expect(panel).toContain("lib line 95");
    expect(panel).not.toContain('class="gap"');
  });

  it("names definition panels for the rails and history", () => {
    expect(html).toContain('id="def-names"');
    expect(html).toContain('"def:a.ts:60:6":"y"');
  });

  it("ships the in-place highlight shortcut", () => {
    expect(html).toContain("inView");
    expect(html).toContain("linkInPlace");
  });

  it("embeds the caller lists and marks each listed call site in its caller's code", () => {
    expect(html).toContain('id="ref-data"');
    expect(html).toContain('"total":12');
    // The site is also a link to the same definition, so one span carries both marks.
    expect(html).toMatch(/class="[^"]*sym ref-site"[^>]*data-ref-of="a\.ts:60:6"/);
    expect(html).toContain("e.metaKey || e.ctrlKey");
    expect(html).not.toContain("contextmenu");
    expect(html).toContain("ref-menu");
  });

  it("ships no debug hints unless asked", () => {
    expect(html).not.toContain("data-why");
    expect(html).not.toContain("id-dbg");
    expect(html).not.toContain("debug-legend");
  });

  it("with --debug-marks, every mark says why it is there and unlinked identifiers say why not", () => {
    const debug = page(true, {
      debug: { "a.ts": [{ line: 4, start: 0, end: 4, why: "not resolved: language service found no definition" }] },
    });
    // Graph symbol found by text match on the slice panel.
    expect(debug).toContain('data-why="csite · text match of graph symbol retry → a.ts#retry"');
    // A resolved symbol names its definition and what it opens.
    expect(debug).toContain('data-why="sym · y (const) a.ts:60:6 in a.ts · opens panel"');
    expect(debug).toContain('data-why="sym · z (variable) d-nopanel in a.ts · no panel: unknown"');
    // Declarations, call sites, and the resolver's own explanations.
    expect(debug).toContain('data-why="decl · retry (function) a.ts#retry"');
    // A span two marks share lists both reasons.
    expect(debug).toContain('data-why="sym · y (const) a.ts:60:6 in a.ts · opens panel | ref-site · reference of a.ts:60:6"');
    expect(debug).toContain('<span class="id-dbg" data-why="not resolved: language service found no definition">line</span>');
    // Identifiers the resolver never saw are pointed out too (line 5 has no entry).
    expect(debug).toContain('<span class="id-dbg" data-why="not visited by the resolver">line</span>');
    // The overlay itself: legend, Shift toggle, per-kind colours.
    expect(debug).toContain('id="debug-legend"');
    expect(debug).toContain('e.key === "Shift"');
    expect(debug).toContain("body.debug-marks [data-why]:hover::after");
  });

});
