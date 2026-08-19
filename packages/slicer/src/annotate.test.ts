import { parseUnifiedDiff } from "@deep-review/pr";
import { describe, expect, it } from "vitest";
import { indexDiff, renderAnnotatedDiff } from "./annotate.js";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const zero = 0;
-const one = 1;
+const one = 11;
+const two = 2;
 const three = 3;
@@ -10,2 +11,2 @@
-old();
+new();
 tail();
diff --git a/src/new.ts b/src/new.ts
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
`;

describe("indexDiff", () => {
  const index = indexDiff(parseUnifiedDiff(DIFF));

  it("numbers hunks per file", () => {
    expect(index.hunks.map((h) => h.id)).toEqual([
      "src/a.ts#0",
      "src/a.ts#1",
      "src/new.ts#0",
    ]);
  });

  it("finds the changed lines of each hunk by body position", () => {
    expect(index.byId.get("src/a.ts#0")!.changedLines).toEqual([2, 3, 4]);
    expect(index.byId.get("src/new.ts#0")!.changedLines).toEqual([1, 2]);
  });

  it("counts every addition and deletion", () => {
    expect(index.changedLineCount).toBe(7);
  });

  it("maps body lines to head-side file lines, skipping deletions", () => {
    // " const zero", "-const one", "+const one = 11", "+const two", " const three"
    expect(index.byId.get("src/a.ts#0")!.newLineNumbers).toEqual([
      1,
      null,
      2,
      3,
      4,
    ]);
  });
});

describe("renderAnnotatedDiff", () => {
  const text = renderAnnotatedDiff(indexDiff(parseUnifiedDiff(DIFF)));

  it("labels each hunk with its id and how the file changed", () => {
    expect(text).toContain("=== HUNK src/a.ts#0 — src/a.ts");
    expect(text).toContain("=== HUNK src/new.ts#0 — src/new.ts (added)");
  });

  it("puts the hunk-local number first and the file line second", () => {
    expect(text).toContain("   3      2 |+const one = 11;");
    // A deletion has no head-side line, so that column is blank.
    expect(text).toContain("   1        |-old();");
  });
});
