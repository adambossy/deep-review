import { describe, expect, it } from "vitest";
import { changedPaths, hunksOverlapping, parseUnifiedDiff } from "./diff.js";

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@ export function foo() {
 context
-old line
+new line
+another new line
 context
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 333..000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-bye
-bye
`;

describe("parseUnifiedDiff", () => {
  it("parses files, hunks, and line ranges", () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files).toHaveLength(2);

    const [a, gone] = files;
    expect(a!.oldPath).toBe("src/a.ts");
    expect(a!.newPath).toBe("src/a.ts");
    expect(a!.hunks).toHaveLength(1);
    expect(a!.hunks[0]).toMatchObject({
      oldStart: 10,
      oldLines: 4,
      newStart: 10,
      newLines: 5,
    });
    expect(a!.hunks[0]!.lines).toHaveLength(5);

    expect(gone!.oldPath).toBe("src/gone.ts");
    expect(gone!.newPath).toBeNull();
  });

  it("collects changed paths from both sides", () => {
    expect([...changedPaths(parseUnifiedDiff(SAMPLE))].sort()).toEqual([
      "src/a.ts",
      "src/gone.ts",
    ]);
  });
});

describe("hunksOverlapping", () => {
  const file = parseUnifiedDiff(SAMPLE)[0]!;

  it("matches a range spanning the hunk", () => {
    expect(hunksOverlapping(file, "old", 1, 100)).toHaveLength(1);
    expect(hunksOverlapping(file, "new", 12, 12)).toHaveLength(1);
  });

  it("rejects a disjoint range", () => {
    expect(hunksOverlapping(file, "old", 1, 9)).toHaveLength(0);
    expect(hunksOverlapping(file, "old", 20, 30)).toHaveLength(0);
  });
});
