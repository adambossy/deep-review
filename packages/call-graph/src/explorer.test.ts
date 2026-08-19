import { describe, expect, it } from "vitest";
import { renderCallPathExplorerHtml } from "./explorer.js";
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
      after: snapshot("mid.ts", ["function mid(n) {", "  return leaf(n) + 1;", "}"]),
      changedInPr: true,
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
      // Whole file added by the PR — but only the function's own lines
      // should be tinted green in the panel, not the surrounding context.
      hunks: [
        {
          header: "@@ -0,0 +1,40 @@",
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 40,
          lines: Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`),
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

  it("tints only the function's own added lines, not surrounding context", () => {
    const leafPanel = html.slice(
      html.lastIndexOf('data-node="leaf.ts#leaf"'),
      html.lastIndexOf('data-node="top.ts#top"'),
    );
    // The panel's last <pre> is the source block (the first is the diff).
    const source = leafPanel.slice(leafPanel.lastIndexOf("<pre"));
    // Function spans 20–21: exactly two tinted rows in the source block.
    expect(source.match(/class="line diff-add"/g)).toHaveLength(2);
    expect(source).toContain('diff-add"><span class="lineno">20</span>');
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
