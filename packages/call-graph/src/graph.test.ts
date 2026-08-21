import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mergeGraphs, walkCallGraph } from "./graph.js";
import { TsBackend } from "./tsBackend.js";
import type { FileDiff } from "./types.js";

// Call chain: top() -> mid() -> target() -> leaf(). The synthetic diff
// touches mid and target only, so the walk should expand through mid and
// stop at the unchanged boundaries top and leaf.
const dir = mkdtempSync(path.join(os.tmpdir(), "graph-test-"));
writeFileSync(path.join(dir, "leaf.ts"), "export function leaf(n: number) {\n  return n + 1;\n}\n");
writeFileSync(
  path.join(dir, "target.ts"),
  'import { leaf } from "./leaf.js";\nexport function target(n: number) {\n  return leaf(n) * 2;\n}\n',
);
writeFileSync(
  path.join(dir, "mid.ts"),
  'import { target } from "./target.js";\nexport function mid(n: number) {\n  return target(n) + 1;\n}\n',
);
writeFileSync(
  path.join(dir, "top.ts"),
  'import { mid } from "./mid.js";\nexport function top() {\n  return mid(1);\n}\n',
);
// A test that calls target directly: diverted to testCallers, not the graph.
writeFileSync(
  path.join(dir, "target.test.ts"),
  [
    'import { target } from "./target.js";',
    "declare function describe(name: string, fn: () => void): void;",
    "declare function it(name: string, fn: () => void): void;",
    'describe("target", () => {',
    '  it("doubles after incrementing", () => {',
    '    if (target(2) !== 6) throw new Error("nope");',
    "  });",
    "});",
    "",
  ].join("\n"),
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const changedFile = (p: string): FileDiff => ({
  oldPath: p,
  newPath: p,
  hunks: [
    { header: `@@ -1,4 +1,4 @@ ${p}`, oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [] },
  ],
});
const diff: FileDiff[] = [changedFile("target.ts"), changedFile("mid.ts")];

const backend = new TsBackend(dir);
const rootDecl = await backend.findFunction("target", new Set());

describe("walkCallGraph", async () => {
  const graph = await walkCallGraph(backend, rootDecl!, diff, "new");

  it("finds the root declaration at its exact name position", () => {
    expect(rootDecl).toMatchObject({ line: 2, column: 16 });
  });

  it("expands through changed functions and stops at unchanged boundaries", () => {
    const byKey = Object.fromEntries(
      [...graph.nodes].map(([k, n]) => [k, n.expanded]),
    );
    expect(byKey).toEqual({
      "target.ts#target": true,
      "mid.ts#mid": true,
      "top.ts#top": false,
      "leaf.ts#leaf": false,
    });
    expect(graph.rootKey).toBe("target.ts#target");
  });

  it("records caller→callee edges along the whole path", () => {
    const edges = [...graph.edges.values()].map((e) => `${e.from}->${e.to}`).sort();
    expect(edges).toEqual([
      "mid.ts#mid->target.ts#target",
      "target.ts#target->leaf.ts#leaf",
      "top.ts#top->mid.ts#mid",
    ]);
  });

  it("gives boundary leaves full source and exact name positions", () => {
    const leaf = graph.nodes.get("leaf.ts#leaf")!;
    expect(leaf.snapshot.source[0]!.lines.join("\n")).toContain("return n + 1;");
    expect(leaf.nameLine).toBe(1);
    expect(leaf.nameColumn).toBe(16);
  });

  it("edges carry call sites with column spans in the caller's source", () => {
    const edge = [...graph.edges.values()].find((e) => e.to === "leaf.ts#leaf")!;
    expect(edge.callSites[0]!.snippet).toContain("leaf(n)");
    expect(edge.callSites[0]!.startColumn).toBeTypeOf("number");
  });

  it("diverts callers in test files to testCallers, keeping them off the graph", () => {
    expect(graph.nodes.has("target.test.ts#it")).toBe(false);
    expect([...graph.nodes.keys()].some((k) => k.startsWith("target.test.ts"))).toBe(false);
    const callers = graph.testCallers.get("target.ts#target")!;
    expect(callers).toHaveLength(1);
    expect(callers[0]!.snapshot.file).toBe("target.test.ts");
    expect(callers[0]!.snapshot.callSites[0]!.snippet).toContain("target(2)");
  });

  it("respects maxDepth", async () => {
    const shallow = await walkCallGraph(backend, rootDecl!, diff, "new", { maxDepth: 0 });
    // mid is changed but too deep to expand; it becomes a leaf.
    expect(shallow.nodes.get("mid.ts#mid")!.expanded).toBe(false);
    expect(shallow.nodes.has("top.ts#top")).toBe(false);
  });
});

describe("testBlockAt", () => {
  it("names the enclosing describe › it chain with the it block's extent", async () => {
    const block = await backend.testBlockAt("target.test.ts", 6);
    expect(block).toEqual({
      breadcrumb: "target › doubles after incrementing",
      startLine: 5,
      endLine: 7,
    });
  });

  it("falls back to the innermost named declaration outside harness calls", async () => {
    // Line 2 sits in `declare function describe`, not inside any test block.
    const block = await backend.testBlockAt("target.test.ts", 2);
    expect(block?.breadcrumb).toBe("describe");
  });
});

describe("mergeGraphs", async () => {
  const graph = await walkCallGraph(backend, rootDecl!, diff, "new");

  it("merges sides and computes presence and change flags", () => {
    const { rootId, nodes, edges } = mergeGraphs(diff, null, graph);
    expect(rootId).toBe("target.ts#target");
    const target = nodes.find((n) => n.id === rootId)!;
    expect(target.presence).toBe("after");
    expect(target.changedInPr).toBe(true);
    const leaf = nodes.find((n) => n.id === "leaf.ts#leaf")!;
    expect(leaf.expanded).toBe(false);
    expect(edges).toHaveLength(3);
    expect(edges.find((e) => e.to === rootId)!.after[0]!.snippet).toContain("target(n)");
  });
});
