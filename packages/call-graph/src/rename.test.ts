import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "@deep-review/pr";
import { detectRenamedDeclarations, renamedCounterparts } from "./rename.js";

const pyDiff = parseUnifiedDiff(
  [
    "diff --git a/tools.py b/tools.py",
    "--- a/tools.py",
    "+++ b/tools.py",
    "@@ -10,8 +10,8 @@ def unrelated():",
    " ",
    "-def _load_principal_job(db, ctx) -> Job | None:",
    "+def _load_principal_run(db, ctx) -> Run | None:",
    '     """docstring"""',
    "-    job = fetch(ctx.job_id)",
    "+    run = fetch(ctx.run_id)",
    "-    return job",
    "+    return run",
    "@@ -40,4 +40,6 @@ def other():",
    "-def _submit_report(db, args, job):",
    "+def _submit_report(",
    "+    db, args, job, run_id",
    "+):",
    "     pass",
  ].join("\n"),
);

describe("detectRenamedDeclarations", () => {
  it("pairs a removed def with the added def replacing it", () => {
    expect(detectRenamedDeclarations(pyDiff)).toEqual([
      {
        oldFile: "tools.py",
        newFile: "tools.py",
        oldName: "_load_principal_job",
        newName: "_load_principal_run",
      },
    ]);
  });

  it("ignores a signature-only change where the name survives", () => {
    const names = detectRenamedDeclarations(pyDiff).map((p) => p.oldName);
    expect(names).not.toContain("_submit_report");
  });

  it("detects TypeScript function renames", () => {
    const tsDiff = parseUnifiedDiff(
      [
        "diff --git a/util.ts b/util.ts",
        "--- a/util.ts",
        "+++ b/util.ts",
        "@@ -1,3 +1,3 @@",
        "-export function loadJob(id: string) {",
        "+export function loadRun(id: string) {",
        "   return fetch(id);",
        " }",
      ].join("\n"),
    );
    expect(detectRenamedDeclarations(tsDiff)).toEqual([
      { oldFile: "util.ts", newFile: "util.ts", oldName: "loadJob", newName: "loadRun" },
    ]);
  });
});

describe("renamedCounterparts", () => {
  it("maps a new name back to its old name and vice versa", () => {
    expect(renamedCounterparts(pyDiff, "_load_principal_run", "old")).toEqual([
      "_load_principal_job",
    ]);
    expect(renamedCounterparts(pyDiff, "_load_principal_job", "new")).toEqual([
      "_load_principal_run",
    ]);
    expect(renamedCounterparts(pyDiff, "_submit_report", "old")).toEqual([]);
  });
});
