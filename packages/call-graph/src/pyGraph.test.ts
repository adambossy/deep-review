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
writeFileSync(path.join(dir, "leaf.py"), "def leaf(n):\n    return n + 1\n");
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
  "from mid import mid\n\n\ndef top():\n    return mid(1)\n",
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
      expect(leaf.snapshot.source[0]!.lines.join("\n")).toContain("return n + 1");
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

  it("resolves a call to its definition in another file", { timeout: 30_000 }, async () => {
    const def = await backend.definitionAt({ fileName: path.join(dir, "target.py"), line: 6, column: 11 });
    expect(def).not.toBeNull();
    expect(def!.fileName).toBe(path.join(dir, "leaf.py"));
    expect([def!.kind, def!.external, def!.nameLine, def!.nameColumn]).toEqual(["function", false, 1, 4]);
    expect([def!.startLine, def!.endLine]).toEqual([1, 2]);
  });

  it("flags a stdlib definition as external and returns null on a declaration", { timeout: 30_000 }, async () => {
    const os = await backend.definitionAt({ fileName: path.join(dir, "target.py"), line: 6, column: 30 });
    expect(os).not.toBeNull();
    expect(os!.external).toBe(true);
    const self = await backend.definitionAt({ fileName: path.join(dir, "target.py"), line: 5, column: 4 });
    expect(self).toBeNull();
  });
});
