import { describe, expect, it } from "vitest";
import {
  fileDiffRows,
  fragmentDiffRows,
  fragmentRows,
  hunkRows,
  markIntraLine,
  renderDiffRows,
  segmentRows,
  type DiffRow,
} from "./diffView.js";
import { buildFileIndex } from "./html.js";
import type { DiffHunk } from "./types.js";

const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1};`);

/** One line added at 30, one removed just before 45. */
const hunks: DiffHunk[] = [
  {
    header: "@@ -29,1 +29,2 @@",
    oldStart: 29,
    oldLines: 1,
    newStart: 29,
    newLines: 2,
    lines: [" line 29;", "+line 30;"],
  },
  {
    header: "@@ -44,2 +45,1 @@",
    oldStart: 44,
    oldLines: 2,
    newStart: 45,
    newLines: 1,
    lines: ["-gone;", " line 45;"],
  },
];

function summary(rows: DiffRow[]): string[] {
  return rows.map((r) => {
    switch (r.kind) {
      case "gap":
        return `gap ${r.from}-${r.to}`;
      case "del":
        return `- ${r.text}`;
      case "add":
        return `+${r.n}`;
      case "ctx":
        return `${r.n}`;
      case "meta":
        return `\\ ${r.text}`;
    }
  });
}

describe("fileDiffRows", () => {
  it("shows each change with context, removed lines above the line they preceded, gaps elsewhere", () => {
    const rows = fileDiffRows(lines, hunks, { context: 3 });
    expect(summary(rows)).toEqual([
      "gap 1-26",
      "27", "28", "29", "+30", "31", "32", "33",
      "gap 34-40",
      "41", "42", "43", "44", "- gone;", "45", "46", "47", "48",
      "gap 49-60",
    ]);
  });

  it("keeps a focused span visible in full, and emits an end-of-file deletion last", () => {
    const eof: DiffHunk[] = [
      { header: "@@ -60,2 +60,1 @@", oldStart: 60, oldLines: 2, newStart: 60, newLines: 1, lines: [" line 60;", "-tail;"] },
    ];
    const rows = fileDiffRows(lines, eof, { context: 1, focus: { startLine: 10, endLine: 12 } });
    expect(summary(rows)).toEqual([
      "gap 1-8", "9", "10", "11", "12", "13", "gap 14-58", "59", "60", "- tail;",
    ]);
  });
});

describe("hunkRows / fragmentRows / segmentRows", () => {
  it("stitches hunks with fixed gaps and no headers", () => {
    expect(summary(hunkRows(hunks))).toEqual([
      "gap 1-28", "29", "+30", "gap 31-44", "- gone;", "45",
    ]);
  });

  it("maps fragment lines by their markers and head numbers", () => {
    const rows = fragmentRows([" a", "+b", "-c", "\\ No newline at end of file"], [1, 2, null, null]);
    expect(summary(rows)).toEqual(["1", "+2", "- c", "\\ \\ No newline at end of file"]);
  });

  it("applies hunks to source segments and gaps the stretch between them", () => {
    const rows = segmentRows(
      [
        { startLine: 28, lines: ["line 28;", "line 29;", "line 30;"] },
        { startLine: 44, lines: ["line 44;", "line 45;"] },
      ],
      hunks,
    );
    expect(summary(rows)).toEqual(["28", "29", "+30", "gap 31-43", "44", "- gone;", "45"]);
  });
});

describe("fragmentDiffRows", () => {
  const first = { lines: [" line 2;", "+line 3;", "-old;"], newLineNumbers: [2, 3, null], headStart: 2, headEnd: 3 };
  const deletion = { lines: ["-gone;"], newLineNumbers: [null], headStart: 40, headEnd: 39 };
  const far = { lines: ["+line 50;"], newLineNumbers: [50], headStart: 50, headEnd: 50 };

  it("shows each fragment with context, merges touching pads, and gaps the rest", () => {
    const rows = fragmentDiffRows(lines, [far, first], 2);
    // Two lines of context before line 2 reach line 1: no gap to open on.
    expect(summary(rows)).toEqual([
      "1", "2", "+3", "- old;", "4", "5",
      "gap 6-47",
      "48", "49", "+50", "51", "52",
      "gap 53-60",
    ]);
  });

  it("puts a deletion-only fragment between the lines it sits at, with context around the point", () => {
    const rows = fragmentDiffRows(lines, [deletion], 2);
    expect(summary(rows)).toEqual(["gap 1-37", "38", "39", "- gone;", "40", "41", "gap 42-60"]);
  });

  it("falls back to the fragments alone, fixed gaps between them, without the file's text", () => {
    const rows = fragmentDiffRows(undefined, [far, first]);
    expect(summary(rows)).toEqual(["2", "+3", "- old;", "gap 4-49", "+50"]);
  });
});

describe("markIntraLine", () => {
  it("pairs equal-length −/+ runs and marks the differing words", () => {
    const rows: DiffRow[] = [
      { kind: "del", text: "const a = 1;" },
      { kind: "del", text: "let b = old();" },
      { kind: "add", n: 1, text: "const a = 2;" },
      { kind: "add", n: 2, text: "let b = fresh();" },
    ];
    markIntraLine(rows);
    expect((rows[0] as { marks?: unknown }).marks).toEqual([{ start: 10, end: 11, cls: "diff-del-inner" }]);
    expect((rows[2] as { marks?: unknown }).marks).toEqual([{ start: 10, end: 11, cls: "diff-add-inner" }]);
    expect((rows[3] as { marks?: unknown }).marks).toEqual([{ start: 8, end: 13, cls: "diff-add-inner" }]);
  });

  it("marks nothing for unequal runs or a rewritten line", () => {
    const unequal: DiffRow[] = [
      { kind: "del", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", n: 1, text: "a2" },
    ];
    markIntraLine(unequal);
    expect(unequal.every((r) => !("marks" in r && r.marks))).toBe(true);
    const rewritten: DiffRow[] = [
      { kind: "del", text: "return foo;" },
      { kind: "add", n: 1, text: "throw bar()" },
    ];
    markIntraLine(rewritten);
    expect(rewritten.every((r) => !("marks" in r && r.marks))).toBe(true);
  });
});

describe("renderDiffRows", () => {
  const entry = buildFileIndex([{ side: "after", path: "x.ts", lines, symbols: [] }]).get("after:x.ts")!;

  it("composes inner marks with overlay marks on one span, and outlines focused rows", () => {
    const rows: DiffRow[] = [
      { kind: "del", text: "call(1);" },
      { kind: "add", n: 5, text: "call(2);" },
    ];
    markIntraLine(rows);
    const html = renderDiffRows(rows, {
      width: 2,
      lang: "ts",
      decorations: new Map([[5, { marks: [{ start: 0, end: 4, cls: "csite", attrs: 'data-target="t"' }] }]]),
      focus: { startLine: 5, endLine: 5 },
    });
    expect(html).toContain('<span class="tok-fn csite" data-target="t">call</span>');
    expect(html).toMatch(/<span class="tok-num diff-add-inner">2<\/span>/);
    expect(html).toMatch(/<span class="tok-num diff-del-inner">1<\/span>/);
    expect(html).toContain('class="line diff-add in-focus"');
    expect(html).toContain('class="line diff-del"');
  });

  it("uses the embedded file's rendering for unmarked rows and expandable gaps for hidden ones", () => {
    const rows: DiffRow[] = [{ kind: "gap", from: 1, to: 3 }, { kind: "ctx", n: 4, text: "line 4;" }];
    const html = renderDiffRows(rows, { width: 2, lang: "ts", entry });
    expect(html).toContain('data-key="after:x.ts" data-from="1" data-to="3"');
    expect(html).toContain(entry.html[3]);
    // Without the file, the gap is a fixed bar.
    expect(renderDiffRows(rows, { width: 2, lang: "ts" })).toContain('class="gap static"');
  });
});
