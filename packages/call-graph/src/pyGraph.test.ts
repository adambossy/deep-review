import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { walkCallGraph } from "./graph.js";
import { LspBackend, pyrightConfig } from "./lspBackend.js";
import type { FileDiff } from "./types.js";

// Same chain as the TS test, in Python, analyzed via pyright over LSP:
// top() -> mid() -> target() -> leaf(); diff touches mid and target.
const dir = mkdtempSync(path.join(os.tmpdir(), "py-graph-test-"));
writeFileSync(path.join(dir, "leaf.py"), "STEP = 1\n\n\ndef leaf(n):\n    return n + STEP\n");
writeFileSync(
  path.join(dir, "target.py"),
  "import os\nfrom leaf import leaf\n\n\ndef target(n):\n    return leaf(n) * 2 + len(os.sep)\n",
);
writeFileSync(
  path.join(dir, "mid.py"),
  "from target import target\n\n\ndef mid(n):\n    return target(n) + 1\n",
);
writeFileSync(
  path.join(dir, "top.py"),
  "from mid import mid\n\n\ndef top():\n    return mid(1)\n\n\ndef deferred():\n    return list(map(mid, [1]))\n",
);
writeFileSync(
  path.join(dir, "shapes.py"),
  "class Shape:\n    def area(self):\n        return 0\n\n    def name(self):\n        return 'shape'\n",
);

const backend = new LspBackend(dir, pyrightConfig());
afterAll(() => {
  backend.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const changedFile = (p: string): FileDiff => ({
  oldPath: p,
  newPath: p,
  hunks: [
    { header: `@@ -1,6 +1,6 @@ ${p}`, oldStart: 1, oldLines: 6, newStart: 1, newLines: 6, lines: [] },
  ],
});
const diff: FileDiff[] = [changedFile("target.py"), changedFile("mid.py")];

describe("pyright backend", () => {
  it(
    "walks a Python call chain through changed functions to unchanged boundaries",
    { timeout: 60_000 },
    async () => {
      const decl = await backend.findFunction("target", new Set(["target.py"]));
      expect(decl).not.toBeNull();
      expect(decl!.fileName.endsWith("target.py")).toBe(true);

      const graph = await walkCallGraph(backend, decl!, diff, "new");
      const byKey = Object.fromEntries(
        [...graph.nodes].map(([k, n]) => [k, n.expanded]),
      );
      expect(byKey).toEqual({
        "target.py#target": true,
        "mid.py#mid": true,
        "top.py#top": false,
        "leaf.py#leaf": false,
      });

      const edges = [...graph.edges.values()].map((e) => `${e.from}->${e.to}`).sort();
      expect(edges).toEqual([
        "mid.py#mid->target.py#target",
        "target.py#target->leaf.py#leaf",
        "top.py#top->mid.py#mid",
      ]);

      const edge = [...graph.edges.values()].find((e) => e.to === "leaf.py#leaf")!;
      expect(edge.callSites[0]!.snippet).toContain("leaf(n)");

      const leaf = graph.nodes.get("leaf.py#leaf")!;
      expect(leaf.snapshot.source[0]!.lines.join("\n")).toContain("return n + STEP");
    },
  );

  it("collects Python file symbols for breadcrumbs, with name positions", { timeout: 30_000 }, async () => {
    const info = await backend.fileInfo("target.py");
    expect(info).not.toBeNull();
    const target = info!.symbols.find((s) => s.name === "target")!;
    expect([target.kind, target.nameLine, target.nameColumn, target.nameEndColumn]).toEqual([
      "function", 5, 4, 10,
    ]);
  });

  it("nests methods under their class", { timeout: 30_000 }, async () => {
    const info = await backend.fileInfo("shapes.py");
    expect(info!.symbols.map((s) => s.name)).toEqual(["Shape"]);
    expect(info!.symbols[0]!.children!.map((s) => `${s.kind}:${s.name}`)).toEqual(["method:area", "method:name"]);
  });

  it("resolves a call to its definition in another file", { timeout: 30_000 }, async () => {
    const def = await backend.definitionAt({ fileName: path.join(dir, "target.py"), line: 6, column: 11 });
    expect(def).not.toBeNull();
    expect(def!.fileName).toBe(path.join(dir, "leaf.py"));
    expect([def!.kind, def!.external, def!.nameLine, def!.nameColumn]).toEqual(["function", false, 4, 4]);
    expect([def!.startLine, def!.endLine]).toEqual([4, 5]);
  });

  it("lists callers of a function and references of a constant, each with its enclosing scope", { timeout: 30_000 }, async () => {
    const calls = await backend.incomingCallsAt({ fileName: path.join(dir, "leaf.py"), line: 4, column: 4 });
    expect(calls!.map((c) => [c.enclosing?.name, path.basename(c.fileName), c.line, c.snippet])).toEqual([
      ["target", "target.py", 6, "return leaf(n) * 2 + len(os.sep)"],
    ]);
    expect(await backend.incomingCallsAt({ fileName: path.join(dir, "leaf.py"), line: 1, column: 0 })).toBeNull();
    const refs = await backend.referencesAt({ fileName: path.join(dir, "leaf.py"), line: 1, column: 0 });
    expect(refs.map((r) => [r.enclosing?.name, r.line, r.startColumn, r.endColumn])).toEqual([["leaf", 5, 15, 19]]);
  });

  it("finds a function passed as a value among its references, but not its import line", { timeout: 30_000 }, async () => {
    const mid = { fileName: path.join(dir, "mid.py"), line: 4, column: 4 };
    const calls = await backend.incomingCallsAt(mid);
    expect(calls!.map((c) => [c.enclosing?.name, c.line])).toEqual([["top", 5]]);
    const refs = await backend.referencesAt(mid);
    expect(refs.map((r) => [r.enclosing?.name, r.line, r.snippet])).toEqual([
      ["top", 5, "return mid(1)"],
      ["deferred", 9, "return list(map(mid, [1]))"],
    ]);
  });

  it("flags a stdlib definition as external and a declaration as itself", { timeout: 30_000 }, async () => {
    const os = await backend.definitionAt({ fileName: path.join(dir, "target.py"), line: 6, column: 30 });
    expect(os).not.toBeNull();
    expect([os!.external, os!.self]).toEqual([true, false]);
    const self = await backend.definitionAt({ fileName: path.join(dir, "target.py"), line: 5, column: 4 });
    expect([self!.self, self!.name, self!.kind, self!.nameLine]).toEqual([true, "target", "function", 5]);
  });
});
