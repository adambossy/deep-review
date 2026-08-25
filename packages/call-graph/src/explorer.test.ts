import { describe, expect, it } from "vitest";
import { panelRange, renderCallPathExplorerHtml, renderDefinitionPanel } from "./explorer.js";
import { buildFileIndex } from "./html.js";
import { NavIndex } from "./navLinks.js";
import type { CallPathResult, DefinitionTarget, FunctionSnapshot, PathNode } from "./types.js";

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

function node(overrides: Partial<PathNode> & Pick<PathNode, "id" | "name" | "file">): PathNode {
  return {
    presence: "both",
    before: null,
    after: snapshot(overrides.file, ["function f() {", "}"]),
    hunks: [],
    changedInPr: false,
    expanded: true,
    nameLine: 1,
    nameColumn: 9,
    ...overrides,
  };
}

const result: CallPathResult = {
  prUrl: "https://github.com/a/b/pull/1",
  prTitle: "A PR",
  functionName: "mid",
  base: { ref: "main", sha: "a".repeat(40) },
  head: { ref: "pull/1/head", sha: "b".repeat(40) },
  rootId: "mid.ts#mid",
  nodes: [
    node({
      id: "mid.ts#mid",
      name: "mid",
      file: "mid.ts",
      // Renamed from oldMid: the hunk removes the old declaration line and
      // adds the new one, and the panel should interleave the removed line.
      before: snapshot("mid.ts", ["function oldMid(n) {", "  return leaf(n) + 1;", "}"]),
      after: snapshot("mid.ts", ["function mid(n) {", "  return leaf(n) + 1;", "}"]),
      hunks: [
        {
          header: "@@ -1,3 +1,3 @@",
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: ["-function oldMid(n) {", "+function mid(n) {", "  return leaf(n) + 1;", " }"],
        },
      ],
      changedInPr: true,
      renamedFrom: "oldMid",
    }),
    node({
      id: "leaf.ts#leaf",
      name: "leaf",
      file: "leaf.ts",
      // A tiny function deep in an embedded file: panel should pad ±10 lines.
      after: {
        file: "leaf.ts",
        startLine: 20,
        endLine: 21,
        callSites: [],
        source: [{ startLine: 20, lines: ["function leaf(n) {", "}"] }],
        truncated: false,
      },
      // The PR added exactly these two lines to an existing file.
      hunks: [
        {
          header: "@@ -19,0 +20,2 @@",
          oldStart: 19,
          oldLines: 0,
          newStart: 20,
          newLines: 2,
          lines: ["+function leaf(n) {", "+}"],
        },
      ],
      changedInPr: true,
      expanded: false,
      nameLine: 20,
      nameColumn: 9,
    }),
    node({
      id: "top.ts#top",
      name: "top",
      file: "top.ts",
      // Unchanged boundary function whose name sits below a JSDoc block —
      // and whose recorded position is stale, exercising the fallback.
      after: snapshot("top.ts", ["/** entry point */", "function top() {", "  return mid(1);", "}"]),
      expanded: false,
      nameLine: 1,
      nameColumn: 0,
    }),
  ],
  edges: [
    {
      from: "mid.ts#mid",
      to: "leaf.ts#leaf",
      before: [],
      after: [{ line: 2, snippet: "return leaf(n) + 1;", startColumn: 9, endColumn: 13 }],
    },
    {
      from: "top.ts#top",
      to: "mid.ts#mid",
      before: [],
      after: [{ line: 3, snippet: "return mid(1);", startColumn: 9, endColumn: 12 }],
    },
  ],
  files: [
    {
      side: "after",
      path: "leaf.ts",
      lines: Array.from({ length: 40 }, (_, i) =>
        i === 19 ? "function leaf(n) {" : i === 20 ? "}" : `// filler ${i + 1}`,
      ),
      symbols: [{ name: "leaf", kind: "function", startLine: 20, endLine: 21 }],
    },
  ],
};

describe("renderCallPathExplorerHtml", () => {
  const html = renderCallPathExplorerHtml(result);

  it("renders a panel definition per node and the root in the track", () => {
    expect(html.match(/data-node="mid\.ts#mid"/g)!.length).toBe(2); // track + defs
    expect(html).toContain('data-node="leaf.ts#leaf"');
    expect(html).toContain('data-root="mid.ts#mid"');
  });

  it("marks outgoing calls as tappable with the callee's node id", () => {
    expect(html).toContain('data-target="leaf.ts#leaf"');
  });

  it("renders tappable called-by rows pointing at caller node ids", () => {
    const midPanel = html.slice(html.indexOf('data-node="mid.ts#mid"'));
    expect(midPanel).toContain('caller-row" data-target="top.ts#top"');
    expect(midPanel).toContain("called by");
  });

  it("labels boundary nodes", () => {
    const leafPanel = html.slice(
      html.lastIndexOf('data-node="leaf.ts#leaf"'),
      html.lastIndexOf('data-node="top.ts#top"'),
    );
    expect(leafPanel).toContain("boundary");
  });

  it("pads a tiny function with ±10 lines of file context", () => {
    const leafPanel = html.slice(
      html.lastIndexOf('data-node="leaf.ts#leaf"'),
      html.lastIndexOf('data-node="top.ts#top"'),
    );
    // Function spans 20–21; visible range should be 10–31 with a gap above.
    expect(leafPanel).toContain("filler 10");
    expect(leafPanel).toContain("filler 31");
    expect(leafPanel).not.toContain("filler 9");
    expect(leafPanel).toContain('data-from="1" data-to="9"');
    expect(leafPanel).toContain('data-from="32" data-to="40"');
  });

  it("tints exactly the added lines and outlines the function's own rows", () => {
    const leafPanel = html.slice(
      html.lastIndexOf('data-node="leaf.ts#leaf"'),
      html.lastIndexOf('data-node="top.ts#top"'),
    );
    // One pane per panel now: no separate diff block, no hunk headers.
    expect(leafPanel.match(/<pre/g)).toHaveLength(1);
    expect(leafPanel).not.toContain('<details class="fn">');
    expect(leafPanel).not.toContain("@@");
    // Function spans 20–21: exactly two added rows, both in focus.
    expect(leafPanel.match(/class="line diff-add in-focus"/g)).toHaveLength(2);
    expect(leafPanel.match(/in-focus"/g)).toHaveLength(2);
    expect(leafPanel).toContain('diff-add in-focus"><span class="lineno">20</span>');
  });

  it("interleaves removed lines as red rows above their replacement, with the changed words marked", () => {
    const midPanel = html.slice(
      html.lastIndexOf('data-node="mid.ts#mid"'),
      html.lastIndexOf('data-node="leaf.ts#leaf"'),
    );
    const deletedRow = /<span class="line diff-del">[^]*?oldMid/.exec(midPanel);
    expect(deletedRow).not.toBeNull();
    // The removed row sits above the added declaration line.
    expect(deletedRow!.index).toBeLessThan(midPanel.indexOf('lineno">1</span>'));
    // `function ` and `(n) {` are shared; only the names differ.
    expect(midPanel).toContain('diff-del-inner">oldMid</span>');
    expect(midPanel).toContain('diff-add-inner self-sym">mid</span>');
    expect(midPanel).not.toContain('diff-del-inner">function');
  });

  it("includes the sliding rails and navigation script", () => {
    expect(html).toContain('class="rail rail-left"');
    expect(html).toContain('class="rail rail-right"');
    expect(html).toContain('id="node-names"');
    expect(html).toContain("--pos");
  });

  it("includes the clicked-symbol linking styles and behavior", () => {
    expect(html).toContain(".sym-link");
    expect(html).toContain(".sym-link.sym-dim");
    expect(html).toContain("linkSymbols");
  });

  it("marks each panel's own symbol name on its declaration line", () => {
    // mid's declaration "function mid(n) {" → the name span carries self-sym.
    expect(html).toContain('self-sym">mid</span>');
    // leaf is backed by an embedded file; its name is marked at line 20.
    const leafPanel = html.slice(
      html.lastIndexOf('data-node="leaf.ts#leaf"'),
      html.lastIndexOf('data-node="top.ts#top"'),
    );
    expect(leafPanel).toContain('self-sym">leaf</span>');
  });

  it("marks the name on unchanged boundary panels, even below a JSDoc block", () => {
    const topPanel = html.slice(html.lastIndexOf('data-node="top.ts#top"'));
    expect(topPanel).toContain('self-sym">top</span>');
  });
});

describe("panelRange", () => {
  it("pads the declaration by ten lines each side, clamped to the file", () => {
    expect(panelRange({ startLine: 20, endLine: 21 }, 40)).toEqual([10, 31]);
    expect(panelRange({ startLine: 3, endLine: 35 }, 40)).toEqual([1, 40]);
  });
});

describe("renderDefinitionPanel", () => {
  const index = buildFileIndex(result.files);
  const internal: DefinitionTarget = {
    id: "leaf.ts:20:9",
    name: "leaf",
    kind: "function",
    file: "leaf.ts",
    external: false,
    nameLine: 20,
    nameColumn: 9,
    nameEndColumn: 13,
    startLine: 20,
    endLine: 21,
    panel: true,
  };
  const external: DefinitionTarget = {
    id: "ext:/abs/lib.d.ts:5:4",
    name: "Thing",
    kind: "interface",
    file: "/abs/lib.d.ts",
    external: true,
    nameLine: 5,
    nameColumn: 10,
    nameEndColumn: 15,
    startLine: 5,
    endLine: 7,
    panel: true,
    source: { startLine: 1, lines: ["// a", "// b", "// c", "// d", "interface Thing {", "  x: 1;", "}"] },
  };
  const nav = new NavIndex({
    links: {},
    definitions: { [internal.id]: internal, [external.id]: external },
  });

  it("renders a repo-internal definition from the embedded file with context and gaps", () => {
    const panel = renderDefinitionPanel(internal, index, nav);
    expect(panel).toContain('data-node="def:leaf.ts:20:9"');
    expect(panel).toContain('self-sym" data-decl="leaf.ts:20:9">leaf</span>');
    expect(panel).toContain("filler 10");
    expect(panel).toContain('data-from="1" data-to="9"');
    expect(panel).toContain('<span class="badge">function</span>');
  });

  it("renders an external definition from its window only, by basename", () => {
    const panel = renderDefinitionPanel(external, index, nav);
    expect(panel).toContain('<span class="badge">external</span>');
    // The machine-specific path stays out of the visible location (it
    // remains in the id attributes, which are what the page matches on).
    expect(panel).toContain("<code>lib.d.ts:5–7</code>");
    expect(/<h3>[\s\S]*?<\/div>/.exec(panel)![0]).not.toContain("/abs/");
    expect(panel).toContain('self-sym" data-decl="ext:/abs/lib.d.ts:5:4">Thing</span>');
    expect(panel).not.toContain('class="gap"');
  });
});
