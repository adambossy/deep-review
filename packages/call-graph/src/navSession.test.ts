import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NavSession, type DefinitionAnswer } from "./navSession.js";
import type { SliceExplorerInput } from "./sliceExplorer.js";
import type { CallPathResult, EmbeddedFile, FileDiff } from "./types.js";

// A tiny TS project: the slice changes `use.ts`, which calls `helper` and
// reads `LIMIT` from `lib.ts`; `helper` is also a call-graph node.
const dir = mkdtempSync(path.join(os.tmpdir(), "nav-session-test-"));
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
  "",
  "export function later(xs: number[]): number[] {",
  "  return xs.map(helper);",
  "}",
];
writeFileSync(path.join(dir, "lib.ts"), libText.join("\n"));
writeFileSync(path.join(dir, "use.ts"), useText.join("\n"));

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

const session = new NavSession(dir, input);
afterAll(() => {
  session.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** A definition the session must be able to answer for. */
async function hit(file: string, line: number, column: number, from: NavSession = session): Promise<DefinitionAnswer> {
  const answer = await from.definition(file, line, column);
  expect(answer).toHaveProperty("id");
  return answer as DefinitionAnswer;
}

describe("NavSession.definition", () => {
  it("resolves a use to its definition, pointing at a graph node's own panel when it has one", async () => {
    const helper = await hit("use.ts", 4, 16);
    expect([helper.name, helper.kind, helper.self, helper.external, helper.panelId]).toEqual([
      "helper", "function", false, false, "lib.ts#helper",
    ]);
    expect(helper.decl).toEqual({ file: "lib.ts", line: 3, column: 16, endColumn: 22 });
  }, 30_000);

  it("hands out one stable id per declaration, whichever use asks", async () => {
    const fromImport = await hit("use.ts", 1, 17);
    const fromBody = await hit("use.ts", 4, 28);
    const again = await hit("use.ts", 4, 28);
    expect(fromImport.id).toBe(fromBody.id);
    expect(again).toEqual(fromBody);
    expect(fromImport.id).toMatch(/^d\d+$/);
    expect(fromImport.panelId).toBe(`def:${fromImport.id}`);
    expect([fromImport.name, fromImport.kind]).toEqual(["LIMIT", "const"]);
  }, 30_000);

  it("answers a click on a declaration with the declaration itself, flagged self", async () => {
    const use = await hit("use.ts", 3, 16);
    expect([use.self, use.name, use.kind, use.decl.line]).toEqual([true, "use", "function", 3]);
  }, 30_000);

  it("says why when nothing resolves", async () => {
    expect(await session.definition("use.ts", 2, 0)).toEqual({ why: "no definition" });
    expect(await session.definition("README.md", 1, 0)).toEqual({ why: "unsupported file" });
  }, 30_000);

  it("flags an external definition and keeps its absolute path", async () => {
    const math = await hit("use.ts", 5, 17);
    expect(math.external).toBe(true);
    expect(path.isAbsolute(math.decl.file)).toBe(true);
  }, 30_000);
});

describe("NavSession.references", () => {
  it("lists every caller of a function with the panel to walk up into", async () => {
    const helper = await hit("use.ts", 4, 16);
    const refs = (await session.references(helper.id))!;
    expect(refs.kind).toBe("calls");
    // `later` hands `helper` to `map` without calling it: invisible to call
    // hierarchy, found by the reference search, flagged as indirect.
    expect(refs.sites.map((s) => [s.file, s.line, s.startColumn, s.enclosingName, s.indirect ?? false])).toEqual([
      ["use.ts", 4, 16, "use", false],
      ["use.ts", 9, 16, "later", true],
    ]);
    // `use` is not a graph node: its panel is a definition panel, rendered when asked for.
    expect(refs.sites[0]!.panelId).toMatch(/^def:d\d+$/);
    expect(await session.references(helper.id)).toBe(refs);
  }, 30_000);

  it("lists references, uncapped, for a symbol call hierarchy does not answer for", async () => {
    const limit = await hit("use.ts", 4, 28);
    const refs = (await session.references(limit.id))!;
    expect(refs.kind).toBe("references");
    // The import binding on use.ts:1 is not a use.
    expect(refs.sites.map((s) => `${s.file}:${s.line}`).sort()).toEqual(["lib.ts:4", "use.ts:4"]);
    // A site inside a graph node walks up into that node's own panel.
    expect(refs.sites.find((s) => s.file === "lib.ts")!.panelId).toBe("lib.ts#helper");
  }, 30_000);

  it("knows nothing about an id it never handed out", async () => {
    expect(await session.references("d999")).toBeNull();
  });
});

describe("NavSession.panel", () => {
  it("renders a definition in an embedded file from that file, once", async () => {
    const total = await hit("use.ts", 5, 9);
    const panel = (await session.panel(total.panelId))!;
    expect([panel.id, panel.name]).toEqual([total.panelId, "total"]);
    expect(panel.html).toContain(`data-node="${total.panelId}"`);
    expect(panel.html).toContain(`self-sym" data-decl="${total.id}">total</span>`);
    expect(panel.html).toContain('data-file="use.ts" data-side="after"');
    // The bare definition id names the same panel, from the same cache.
    expect(await session.panel(total.id)).toBe(panel);
  }, 30_000);

  it("does not serve a graph node's panel — the page already has it", async () => {
    const helper = await hit("use.ts", 4, 16);
    expect(await session.panel(helper.panelId)).toBeNull();
    expect(await session.panel("def:d999")).toBeNull();
  }, 30_000);

  it("windows a definition whose file is not on the page", async () => {
    // Without the graph, lib.ts is not embedded and helper is not a node.
    const bare = new NavSession(dir, { ...input, slices: [{ ...input.slices[0]!, graph: undefined }] });
    try {
      const helper = await hit("use.ts", 4, 16, bare);
      expect(helper.panelId).toBe(`def:${helper.id}`);
      const panel = (await bare.panel(helper.panelId))!;
      // The window is the whole seven-line file: context on both sides of helper.
      expect(panel.html).toContain('<span class="lineno">1</span>');
      expect(panel.html).toContain('<span class="lineno">7</span>');
      expect(panel.html).toContain('self-sym" data-decl="' + helper.id + '">helper</span>');
      expect(panel.html).toContain('data-file="lib.ts"');
      expect(panel.html).not.toContain('class="gap"');
    } finally {
      bare.dispose();
    }
  }, 30_000);

  it("shades a definition from the PR's diff, whichever slice claimed the change", async () => {
    // The only slice touches use.ts; `LIMIT` was added over in lib.ts, so
    // its panel is shaded from the PR's diff or not at all.
    const diff: FileDiff[] = [
      {
        oldPath: "lib.ts",
        newPath: "lib.ts",
        hunks: [
          {
            header: "@@ -0,0 +1,1 @@",
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: [`+${libText[0]}`],
          },
        ],
      },
    ];
    const withDiff = new NavSession(dir, { ...input, diff });
    try {
      const limit = await hit("use.ts", 4, 28, withDiff);
      const panel = (await withDiff.panel(limit.panelId))!;
      expect(panel.name).toBe("LIMIT");
      expect(panel.html).toContain("diff-add");
      // Without the diff the same panel has nothing to shade with.
      const plain = (await session.panel((await hit("use.ts", 4, 28)).panelId))!;
      expect(plain.html).not.toContain("diff-add");
    } finally {
      withDiff.dispose();
    }
  }, 30_000);

  it("renders an external definition from a window of its file, labelled external", async () => {
    const math = await hit("use.ts", 5, 17);
    const panel = (await session.panel(math.panelId))!;
    expect(panel.html).toContain('<span class="badge">external</span>');
    expect(panel.html).toContain("Math");
  }, 30_000);
});
