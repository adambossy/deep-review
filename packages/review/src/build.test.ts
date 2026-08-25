import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseUnifiedDiff } from "@deep-review/pr";
import { indexDiff } from "@deep-review/slicer";
import type { SliceReport } from "@deep-review/slicer";
import { afterAll, describe, expect, it } from "vitest";
import { buildSliceExplorerInput } from "./build.js";

const DIFF = `diff --git a/src/new.ts b/src/new.ts
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,4 @@
+export const a = 1;
+export const b = 2;
+export const c = 3;
+export const d = 4;
`;

const index = indexDiff(parseUnifiedDiff(DIFF));

function report(startLine: number, endLine: number): SliceReport {
  return {
    pr: {
      url: "https://github.com/a/b/pull/1",
      owner: "a",
      repo: "b",
      number: 1,
      title: "A PR",
      baseSha: "a".repeat(40),
      mergeBaseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
    tickets: [],
    overview: "adds constants",
    // No target, so no call graph is attempted and the test stays offline.
    slices: [
      {
        id: "slice-1",
        title: "Constants",
        summary: "s",
        rationale: "r",
        fragments: [
          {
            id: `src/new.ts#0@${startLine}-${endLine}`,
            hunkId: "src/new.ts#0",
            file: "src/new.ts",
            startLine,
            endLine,
            summary: "f",
          },
        ],
      },
    ],
    model: "test",
    generatedAt: "2026-08-19T00:00:00.000Z",
  };
}

describe("buildSliceExplorerInput", () => {
  it("carries only the fragment's own lines, not the whole hunk", async () => {
    const input = await buildSliceExplorerInput({ report: report(2, 3), index });
    const fragment = input.slices[0]!.fragments[0]!;
    expect(fragment.lines).toEqual([
      "+export const b = 2;",
      "+export const c = 3;",
    ]);
    expect(fragment.newLineNumbers).toEqual([2, 3]);
    expect(fragment.hunkHeader).toBe("@@ -0,0 +1,4 @@");
  });

  it("leaves a slice without a target ungraphed rather than guessing", async () => {
    const input = await buildSliceExplorerInput({ report: report(1, 4), index });
    expect(input.slices[0]!.graph).toBeUndefined();
    expect(input.slices[0]!.target).toBeUndefined();
  });

  it("drops a fragment whose hunk is missing instead of throwing", async () => {
    const broken = report(1, 4);
    broken.slices[0]!.fragments[0]!.hunkId = "src/gone.ts#0";
    const input = await buildSliceExplorerInput({ report: broken, index });
    expect(input.slices[0]!.fragments).toEqual([]);
  });

  it("leaves navigation off without a head checkout", async () => {
    const input = await buildSliceExplorerInput({ report: report(1, 4), index });
    expect(input.nav).toBeUndefined();
  });
});

describe("buildSliceExplorerInput with a head checkout", () => {
  const headDir = mkdtempSync(path.join(os.tmpdir(), "build-test-head-"));
  mkdirSync(path.join(headDir, "src"));
  writeFileSync(
    path.join(headDir, "src", "new.ts"),
    "export const a = 1;\nexport const b = a + 1;\nexport const c = b;\nexport const d = 4;\n",
  );
  afterAll(() => rmSync(headDir, { recursive: true, force: true }));

  it("resolves symbols on the changed lines to their definitions", async () => {
    const input = await buildSliceExplorerInput({ report: report(2, 3), index, headDir });
    const links = input.nav?.links["src/new.ts"] ?? [];
    // `a` on line 2 and `b` on line 3 point back at lines 1 and 2.
    const targets = links.map((l) => [l.line, input.nav!.definitions[l.def]!.nameLine]);
    expect(targets).toEqual(expect.arrayContaining([[2, 1], [3, 2]]));
  }, 30_000);

  it("can be switched off", async () => {
    const input = await buildSliceExplorerInput({ report: report(2, 3), index, headDir, navigation: false });
    expect(input.nav).toBeUndefined();
  });

  it("embeds the changed files with their text so the page has context and scopes", async () => {
    const input = await buildSliceExplorerInput({ report: report(2, 3), index, headDir, navigation: false });
    expect(input.files.map((f) => [f.path, f.lines.length])).toEqual([["src/new.ts", 5]]);
  });
});
