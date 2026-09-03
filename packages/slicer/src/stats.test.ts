import { parseUnifiedDiff } from "@deep-review/pr";
import { describe, expect, it } from "vitest";
import { indexDiff } from "./annotate.js";
import { countDelta, fragmentDelta, fragmentTotals, reportTotals } from "./stats.js";
import type { Fragment, FragmentKind, SliceReport } from "./types.js";

// One modified file (context, additions, deletions, and a no-newline marker)
// and one added test file.
const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 import { x } from "./x";
-const old = 1;
+const fresh = 1;
+const extra = 2;
 export { x };
-export default old;
+export default fresh;
\\ No newline at end of file
diff --git a/src/a.test.ts b/src/a.test.ts
--- /dev/null
+++ b/src/a.test.ts
@@ -0,0 +1,2 @@
+import { fresh } from "./a";
+expect(fresh).toBe(1);
`;

const index = indexDiff(parseUnifiedDiff(DIFF));

function fragment(
  hunkId: string,
  startLine: number,
  endLine: number,
  kind?: FragmentKind,
): Fragment {
  return {
    id: `${hunkId}@${startLine}-${endLine}`,
    hunkId,
    file: hunkId.split("#")[0]!,
    startLine,
    endLine,
    summary: "f",
    ...(kind ? { kind } : {}),
  };
}

function report(...fragmentLists: Fragment[][]): SliceReport {
  return {
    pr: {
      url: "https://github.com/a/b/pull/1",
      owner: "a",
      repo: "b",
      number: 1,
      title: "t",
      description: "",
      author: "",
      baseSha: "b",
      mergeBaseSha: "m",
      headSha: "h",
    },
    tickets: [],
    overview: "o",
    slices: fragmentLists.map((fragments, i) => ({
      id: `slice-${i + 1}`,
      title: `s${i + 1}`,
      summary: "s",
      rationale: "r",
      fragments,
    })),
    model: "test",
    generatedAt: "2026-09-03T00:00:00.000Z",
  };
}

describe("countDelta", () => {
  it("counts only added and removed lines", () => {
    expect(countDelta([" ctx", "+a", "-b", "-c", "\\ No newline at end of file"])).toEqual({
      additions: 1,
      deletions: 2,
    });
  });
});

describe("indexDiff totals", () => {
  it("splits the changed line count into additions and deletions", () => {
    expect(index.additions).toBe(5);
    expect(index.deletions).toBe(2);
    expect(index.changedLineCount).toBe(7);
  });
});

describe("fragmentDelta", () => {
  it("excludes the context lines a fragment spans", () => {
    // Lines 1-4 of the first hunk: context, -, +, +.
    expect(fragmentDelta(fragment("src/a.ts#0", 1, 4), index)).toEqual({
      additions: 2,
      deletions: 1,
    });
  });

  it("ignores the no-newline marker", () => {
    // Lines 6-8: -, +, "\ No newline".
    expect(fragmentDelta(fragment("src/a.ts#0", 6, 8), index)).toEqual({
      additions: 1,
      deletions: 1,
    });
  });

  it("counts a fragment whose hunk is missing as nothing", () => {
    expect(fragmentDelta(fragment("src/gone.ts#0", 1, 1), index)).toEqual({
      additions: 0,
      deletions: 0,
    });
  });
});

describe("fragmentTotals", () => {
  it("buckets by kind when every fragment is classified", () => {
    const totals = fragmentTotals(
      [
        fragment("src/a.ts#0", 2, 4, "core"),
        fragment("src/a.ts#0", 6, 7, "boilerplate"),
        fragment("src/a.test.ts#0", 1, 2, "test"),
      ],
      index,
    );
    expect(totals).toEqual({
      kinds: true,
      byKind: {
        core: { additions: 2, deletions: 1 },
        test: { additions: 2, deletions: 0 },
        boilerplate: { additions: 1, deletions: 1 },
      },
      total: { additions: 5, deletions: 2 },
    });
  });

  it("falls back to an unsplit total when any fragment lacks a kind", () => {
    const totals = fragmentTotals(
      [fragment("src/a.ts#0", 2, 4, "core"), fragment("src/a.ts#0", 6, 7)],
      index,
    );
    expect(totals).toEqual({ kinds: false, total: { additions: 3, deletions: 2 } });
  });
});

describe("reportTotals", () => {
  it("matches the diff when the slices cover every changed line", () => {
    const totals = reportTotals(
      report(
        [fragment("src/a.ts#0", 2, 4, "core"), fragment("src/a.test.ts#0", 1, 2, "test")],
        [fragment("src/a.ts#0", 6, 7, "boilerplate")],
      ),
      index,
    );
    expect(totals.total).toEqual({ additions: 5, deletions: 2 });
    expect(totals.kinds).toBe(true);
  });

  it("throws when the fragments do not add up to the diff", () => {
    expect(() =>
      reportTotals(report([fragment("src/a.ts#0", 2, 4, "core")]), index),
    ).toThrow(/sum to \+2 −1 but the diff has \+5 −2/);
  });
});
