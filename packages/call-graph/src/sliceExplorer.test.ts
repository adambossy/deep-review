import { describe, expect, it } from "vitest";
import { renderSliceExplorerHtml, type SliceInput } from "./sliceExplorer.js";
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

function node(id: string, name: string, file: string): PathNode {
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
    nameLine: 1,
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
  nodes: [node("a.ts#retry", "retry", "a.ts"), node("a.ts#retryDelay", "retryDelay", "a.ts")],
  edges: [],
  files: [],
};

const fragment = {
  id: "a.ts#0@1-3",
  file: "a.ts",
  summary: "calls retry",
  hunkHeader: "@@ -1,2 +1,3 @@",
  lines: [" const x = 1;", "+retry();", "-const retryDelayed = 2;"],
  newLineNumbers: [1, 2, null] as (number | null)[],
};

function render(overrides: Partial<SliceInput> = {}): string {
  return renderSliceExplorerHtml({
    prUrl: "https://github.com/a/b/pull/1",
    prTitle: "A PR",
    repo: "a/b",
    number: 1,
    overview: "does a thing",
    slices: [
      {
        id: "slice-1",
        title: "First",
        summary: "s",
        rationale: "r",
        target: { file: "a.ts", name: "retry" },
        fragments: [fragment],
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
    expect([...html.matchAll(/class="panel-defs"/g)]).toHaveLength(2);
  });

  it("makes graph symbols in the diff tappable", () => {
    expect(html).toContain('data-target="a.ts#retry"');
  });

  it("matches whole words only, so retryDelayed is not a call to retry", () => {
    const marks = [...html.matchAll(/data-target="a\.ts#retry"/g)];
    expect(marks).toHaveLength(1);
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
});
