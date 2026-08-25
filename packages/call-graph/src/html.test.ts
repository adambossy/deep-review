import { describe, expect, it } from "vitest";
import { renderCallGraphColumnsHtml, renderCallGraphHtml } from "./html.js";
import type { CallGraphResult, FunctionSnapshot } from "./types.js";

// Synthetic embedded file: 130 lines, bigCaller spans 10–110.
const bigFileLines = Array.from({ length: 130 }, (_, i) => {
  const n = i + 1;
  if (n === 10) return "function bigCaller() {";
  if (n === 50) return "  x() + <tag>";
  if (n === 110) return "}";
  return `  const line${n} = ${n};`;
});

function snapshot(overrides: Partial<FunctionSnapshot>): FunctionSnapshot {
  return {
    file: "src/x.ts",
    startLine: 1,
    endLine: 3,
    callSites: [],
    source: [{ startLine: 1, lines: ["function x() {", "  return zap(1);", "}"] }],
    truncated: false,
    ...overrides,
  };
}

const result: CallGraphResult = {
  prUrl: "https://github.com/a/b/pull/1",
  prTitle: "A PR",
  functionName: "x",
  base: { ref: "main", sha: "a".repeat(40) },
  head: { ref: "pull/1/head", sha: "b".repeat(40) },
  target: {
    name: "x",
    before: snapshot({}),
    after: snapshot({}),
    hunks: [],
    changedInPr: false,
  },
  callers: [
    {
      name: "steadyCaller",
      file: "src/steady.ts",
      presence: "both",
      // Identical code on both sides; line numbers shifted by edits above it.
      before: snapshot({
        file: "src/steady.ts",
        startLine: 5,
        endLine: 7,
        source: [{ startLine: 5, lines: ["function steady() {", "  x();", "}"] }],
      }),
      after: snapshot({
        file: "src/steady.ts",
        startLine: 9,
        endLine: 11,
        source: [{ startLine: 9, lines: ["function steady() {", "  x();", "}"] }],
      }),
      hunks: [],
      changedInPr: false,
    },
    {
      name: "bigCaller",
      file: "src/big.ts",
      presence: "after",
      before: null,
      after: snapshot({
        file: "src/big.ts",
        startLine: 10,
        endLine: 110,
        callSites: [
          { line: 50, snippet: "x() + <tag>", startColumn: 2, endColumn: 3 },
        ],
        source: [
          { startLine: 10, lines: [bigFileLines[9]!] },
          { startLine: 40, lines: bigFileLines.slice(39, 60) },
        ],
        truncated: true,
      }),
      hunks: [],
      changedInPr: false,
    },
  ],
  callees: [
    {
      name: "addedCallee",
      file: "src/added.ts",
      presence: "after",
      before: null,
      after: snapshot({
        file: "src/added.ts",
        source: [{ startLine: 1, lines: ["function addedCallee() {", "}"] }],
        endLine: 2,
      }),
      hunks: [
        {
          header: "@@ -0,0 +1,2 @@",
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 2,
          lines: ["+function addedCallee() {", "+}"],
        },
      ],
      changedInPr: true,
    },
    {
      name: "zap",
      file: "src/zap.ts",
      presence: "both",
      before: null,
      after: snapshot({
        file: "src/zap.ts",
        startLine: 1,
        endLine: 3,
        // Call sites live in the target's file.
        callSites: [
          { line: 2, snippet: "return zap(1);", startColumn: 9, endColumn: 12 },
        ],
        source: [{ startLine: 1, lines: ["function zap(n) {", "  return n;", "}"] }],
      }),
      hunks: [],
      changedInPr: false,
    },
  ],
  files: [
    {
      side: "after",
      path: "src/big.ts",
      lines: bigFileLines,
      symbols: [
        {
          name: "Outer",
          kind: "class",
          startLine: 5,
          endLine: 120,
          children: [{ name: "bigCaller", kind: "function", startLine: 10, endLine: 110 }],
        },
      ],
    },
  ],
};

function withoutDataBlobs(html: string): string {
  return html.replaceAll(/<script type="application\/json"[\s\S]*?<\/script>/g, "");
}

describe("renderCallGraphHtml", () => {
  const html = renderCallGraphHtml(result);

  it("renders one combined block when a function is identical on both sides", () => {
    const steady = html.slice(html.indexOf("steadyCaller"), html.indexOf("bigCaller"));
    expect(steady).toContain('class="side side-both"');
    expect(steady).not.toContain('class="side side-before"');
    expect(steady.match(/class="source"/g)).toHaveLength(1);
  });

  it("renders expander gaps with symbol breadcrumbs for embedded files", () => {
    // Hidden lines 11–39 between bigCaller's signature and the call window.
    expect(html).toContain('data-key="after:src/big.ts" data-from="11" data-to="39"');
    expect(html).toContain("29 hidden lines");
    expect(html).toContain('<span class="gap-crumb">class Outer › bigCaller()</span>');
    // Trailing gap runs to the end of the file, not the end of the function.
    expect(html).toContain('data-from="61" data-to="130"');
  });

  it("ships the symbol tree and the sticky scope header script", () => {
    expect(html).toContain('"symbols":[{"l":"class Outer","n":"Outer","s":5,"e":120,"c":[{"l":"bigCaller()"');
    expect(html).toContain("updateScopeBars");
  });

  it("marks the call to the target inside the caller's source", () => {
    // Column 2–3 of line 50 is the `x` in `x() + <tag>`.
    expect(html).toContain('class="tok-fn callsite">x</span>');
  });

  it("syntax-highlights source", () => {
    expect(html).toContain('<span class="tok-kw">function</span>');
  });

  it("renders separate sides when only one revision has the function", () => {
    const big = html.slice(
      html.indexOf("bigCaller"),
      html.indexOf('<section class="target-card">'),
    );
    expect(big).toContain("not present before the PR");
  });

  it("shows no source body on the target card, only locations and hunks", () => {
    const targetCard = html.slice(
      html.indexOf('<section class="target-card">'),
      html.indexOf('class="group group-callees"'),
    );
    expect(targetCard).not.toContain('class="source"');
  });

  it("escapes source content in the rendered page", () => {
    const rendered = withoutDataBlobs(html);
    expect(rendered).not.toContain("x() + <tag>");
    expect(rendered).toContain("&lt;tag&gt;");
  });

  it("places callers before the target and callees after", () => {
    const callers = html.indexOf('class="group group-callers"');
    const target = html.indexOf('<section class="target-card">');
    const callees = html.indexOf('class="group group-callees"');
    expect(callers).toBeGreaterThan(-1);
    expect(callers).toBeLessThan(target);
    expect(target).toBeLessThan(callees);
  });
});

describe("renderCallGraphColumnsHtml", () => {
  const html = renderCallGraphColumnsHtml(result);

  it("lays out callers | target | callees columns", () => {
    const callers = html.indexOf('class="col col-callers"');
    const target = html.indexOf('class="col col-target"');
    const callees = html.indexOf('class="col col-callees"');
    expect(callers).toBeGreaterThan(-1);
    expect(callers).toBeLessThan(target);
    expect(target).toBeLessThan(callees);
  });

  it("makes callee call sites in the target clickable", () => {
    // zap is the second callee (index 1); addedCallee has no call-site columns.
    expect(html).toContain('data-callee="1"');
    expect(html).toContain("csite");
  });

  it("hides callee panels until selected and shows no callee call-site list", () => {
    expect(html).toContain('<article class="callee-panel" data-idx="0" hidden>');
    const panel = html.slice(html.indexOf('<article class="callee-panel"'));
    expect(panel).not.toContain("call sites in target");
  });

  it("shows only the diff for changed callees, no before/after source", () => {
    const panel = html.slice(
      html.indexOf('<article class="callee-panel" data-idx="0"'),
      html.indexOf('<article class="callee-panel" data-idx="1"'),
    );
    expect(panel).toContain('class="line diff-add"');
    expect(panel).not.toContain("@@");
    expect(panel).not.toContain('class="side side-');
    expect(panel).not.toContain("not present before the PR");
  });

  it("keeps the source block for unchanged callees (no diff to show)", () => {
    const panel = html.slice(html.indexOf('<article class="callee-panel" data-idx="1"'));
    expect(panel).toContain('class="source"');
  });

  it("puts a scope header over the target's code", () => {
    // The target is not in an embedded file: path only, nothing to follow.
    expect(html).toContain('<div class="scope-bar"><span class="scope-path">src/x.ts</span><span class="scope-sym"></span></div>');
  });

  it("renders clickable rails for the two-pane slide", () => {
    expect(html).toContain('class="rail rail-left"');
    expect(html).toContain('class="rail rail-right"');
    // The slide is driven by these state classes on the .cols strip.
    expect(html).toContain(".cols.slid .col-callers");
    expect(html).toContain(".cols.has-selection:not(.slid) .rail-right");
  });
});
