import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveNavigation, visibleLines } from "./navigation.js";
import type { SliceExplorerInput } from "./sliceExplorer.js";
import type { CallPathResult, EmbeddedFile } from "./types.js";

// A tiny TS project: the slice changes `use.ts`, which calls `helper` and
// reads `LIMIT` from `lib.ts`; `helper` is also a call-graph node.
const dir = mkdtempSync(path.join(os.tmpdir(), "navigation-test-"));
const libText = [
  "export const LIMIT = 3;",
  "",
  "export function helper(n: number): number {",
  "  return n + LIMIT;",
  "}",
  "",
  "export function unrelated(): void {}",
];
const useText = [
  'import { helper, LIMIT } from "./lib.js";',
  "",
  "export function use(x: number): number {",
  "  const total = helper(x) + LIMIT;",
  "  return total + Math.max(total, 0);",
  "}",
];
writeFileSync(path.join(dir, "lib.ts"), libText.join("\n"));
writeFileSync(path.join(dir, "use.ts"), useText.join("\n"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const files: EmbeddedFile[] = [{ side: "after", path: "use.ts", lines: useText, symbols: [] }];

const graph: CallPathResult = {
  prUrl: "https://github.com/a/b/pull/1",
  prTitle: "A PR",
  functionName: "use",
  base: { ref: "main", sha: "a".repeat(40) },
  head: { ref: "pull/1/head", sha: "b".repeat(40) },
  rootId: "use.ts#use",
  nodes: [
    {
      id: "lib.ts#helper",
      name: "helper",
      file: "lib.ts",
      presence: "both",
      before: null,
      after: {
        file: "lib.ts",
        startLine: 3,
        endLine: 5,
        callSites: [],
        source: [{ startLine: 3, lines: libText.slice(2, 5) }],
        truncated: false,
      },
      hunks: [],
      changedInPr: false,
      expanded: false,
      nameLine: 3,
      nameColumn: 16,
    },
  ],
  edges: [],
  files: [{ side: "after", path: "lib.ts", lines: libText, symbols: [] }],
};

const input: SliceExplorerInput = {
  prUrl: "https://github.com/a/b/pull/1",
  prTitle: "A PR",
  repo: "a/b",
  number: 1,
  overview: "o",
  files,
  slices: [
    {
      id: "s1",
      title: "Use helper",
      summary: "s",
      rationale: "r",
      fragments: [
        {
          id: "use.ts#0@4-4",
          file: "use.ts",
          summary: "f",
          hunkHeader: "@@ -4,1 +4,1 @@",
          lines: ["+  const total = helper(x) + LIMIT;"],
          newLineNumbers: [4],
          headStart: 4,
          headEnd: 4,
        },
      ],
      graph,
    },
  ],
};

describe("visibleLines", () => {
  it("mirrors the renderers: fragment lines first, then context, then panel bodies", () => {
    const wanted = visibleLines(input);
    expect([...wanted.get("use.ts")!].sort((a, b) => a[0] - b[0])).toEqual([
      [1, 1], [2, 1], [3, 1], [4, 0], [5, 1], [6, 1],
    ]);
    // helper spans 3–5 in a 7-line file: panel shows 1–7.
    expect([...wanted.get("lib.ts")!.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect([...wanted.get("lib.ts")!.values()].every((p) => p === 2)).toBe(true);
  });
});

describe("resolveNavigation", () => {
  it("links identifiers to deduped definitions, reusing graph-node panels", async () => {
    const nav = await resolveNavigation(dir, input);

    const useLinks = nav.links["use.ts"]!;
    const at = (line: number, text: string) =>
      useLinks.find((l) => l.line === line && useText[line - 1]!.slice(l.start, l.end) === text);

    // `helper` on the changed line resolves to the graph node's declaration.
    const helperDef = nav.definitions[at(4, "helper")!.def]!;
    expect(helperDef.nodeId).toBe("lib.ts#helper");
    expect([helperDef.file, helperDef.nameLine, helperDef.kind]).toEqual(["lib.ts", 3, "function"]);

    // `LIMIT` at line 1 (import) and line 4 (use) share one definition.
    expect(at(1, "LIMIT")!.def).toBe(at(4, "LIMIT")!.def);
    const limitDef = nav.definitions[at(4, "LIMIT")!.def]!;
    expect([limitDef.kind, limitDef.nodeId]).toEqual(["const", undefined]);

    // A local resolves to its own declaration line; the declaration itself is not a link.
    const totalDef = nav.definitions[at(5, "total")!.def]!;
    expect([totalDef.file, totalDef.nameLine, totalDef.nameColumn, totalDef.panel]).toEqual(["use.ts", 4, 8, true]);
    expect(at(4, "total")).toBeUndefined();
    // Ids are short page-local handles, not paths.
    expect(Object.keys(nav.definitions).every((id) => /^d\d+$/.test(id))).toBe(true);

    // Math is external and comes with a source window.
    const mathDef = nav.definitions[at(5, "Math")!.def]!;
    expect(mathDef.external).toBe(true);
    expect(mathDef.source?.lines.length).toBeGreaterThan(0);

    // lib.ts is on the page already (the graph embedded it): no window needed.
    expect(limitDef.source).toBeUndefined();
  }, 30_000);

  it("honours the lookup budget, changed lines first", async () => {
    const nav = await resolveNavigation(dir, input, { maxLookups: 3 });
    const lines = new Set((nav.links["use.ts"] ?? []).map((l) => l.line));
    expect(lines.has(4)).toBe(true);
    expect(lines.size).toBe(1);
  }, 30_000);

  it("spends the panel budget on named declarations before locals", async () => {
    const nav = await resolveNavigation(dir, input, { maxPanels: 1 });
    const withPanel = Object.values(nav.definitions).filter((d) => d.panel && !d.nodeId);
    expect(withPanel.map((d) => d.name)).toEqual(["LIMIT"]);
    // Locals keep their links (for in-place highlighting) but open nothing.
    const total = Object.values(nav.definitions).find((d) => d.name === "total")!;
    expect(total.panel).toBe(false);
    expect(nav.links["use.ts"]!.some((l) => l.def === total.id)).toBe(true);
  }, 30_000);

  it("windows a definition whose file is not on the page, and links inside the window", async () => {
    const noGraph: SliceExplorerInput = {
      ...input,
      slices: [{ ...input.slices[0]!, graph: undefined }],
    };
    const nav = await resolveNavigation(dir, noGraph);
    const helperDef = Object.values(nav.definitions).find((d) => d.name === "helper")!;
    expect(helperDef.nodeId).toBeUndefined();
    expect(helperDef.source).toEqual({ startLine: 1, lines: libText });
    // The body's `LIMIT` (line 4 of lib.ts) was resolved in the second pass.
    expect(nav.links["lib.ts"]!.some((l) => l.line === 4)).toBe(true);
  }, 30_000);
});
