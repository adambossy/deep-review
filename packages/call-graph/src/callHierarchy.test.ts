import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createProjectService,
  definitionAt,
  fileSnapshot,
  findFunction,
  getRelations,
  incomingCallsAt,
  referencesAt,
} from "./callHierarchy.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "call-graph-test-"));

writeFileSync(
  path.join(dir, "main.ts"),
  `import { helper } from "./helper.js";

export function target(x: number): number {
  return helper(x) + Math.max(x, 1);
}
`,
);
writeFileSync(
  path.join(dir, "helper.ts"),
  `export const SCALE = 2;

export function helper(x: number): number {
  return x * SCALE;
}
`,
);
writeFileSync(
  path.join(dir, "consumer.ts"),
  `import { target } from "./main.js";

export function useTarget(): number {
  return target(1) + target(2);
}
`,
);

const filler = Array.from({ length: 70 }, (_, i) => `  const x${i} = ${i};`).join("\n");
writeFileSync(
  path.join(dir, "big.ts"),
  `import { target } from "./main.js";

export function bigCaller(): number {
${filler}
  return target(3);
}
`,
);

writeFileSync(
  path.join(dir, "klass.ts"),
  `export class Widget {
  render(): number {
    return this.#compute();
  }

  #compute(): number {
    return 42;
  }
}
`,
);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("call hierarchy over a fixture project", () => {
  const ps = createProjectService(dir);
  const fn = findFunction(ps, "target", new Set());

  it("finds the function declaration", () => {
    expect(fn).not.toBeNull();
    expect(fn!.relativeFile).toBe("main.ts");
  });

  it("reports callers with call sites and full source for small functions", () => {
    const relations = getRelations(ps, fn!);
    expect(relations).not.toBeNull();
    const caller = relations!.callers.find((c) => c.name === "useTarget")!;
    expect(caller.snapshot.file).toBe("consumer.ts");
    expect(caller.snapshot.callSites[0]!.snippet).toContain("target(1)");
    expect(caller.snapshot.truncated).toBe(false);
    const source = caller.snapshot.source.flatMap((s) => s.lines).join("\n");
    expect(source).toContain("export function useTarget");
    expect(source).toContain("target(1) + target(2)");
  });

  it("elides large callers to context windows around call sites", () => {
    const relations = getRelations(ps, fn!);
    const big = relations!.callers.find((c) => c.name === "bigCaller")!;
    expect(big.snapshot.truncated).toBe(true);
    const [signature, window] = big.snapshot.source;
    expect(signature!.lines[0]).toContain("export function bigCaller");
    expect(window!.lines.join("\n")).toContain("target(3)");
    // 10 lines of context on each side of the call, plus the closing line.
    expect(window!.lines.length).toBeLessThanOrEqual(22);
    const shown = big.snapshot.source.reduce((n, s) => n + s.lines.length, 0);
    expect(shown).toBeLessThan(big.snapshot.endLine - big.snapshot.startLine + 1);
  });

  it("reports callees with full source and call sites in the target's body", () => {
    const relations = getRelations(ps, fn!);
    const callees = relations!.callees;
    expect(callees.map((c) => c.name)).toEqual(["helper"]);
    expect(callees[0]!.snapshot.file).toBe("helper.ts");
    expect(callees[0]!.snapshot.callSites[0]!.snippet).toContain("helper(x)");
    const source = callees[0]!.snapshot.source.flatMap((s) => s.lines).join("\n");
    expect(source).toContain("export function helper");
    expect(source).toContain("return x * SCALE;");
    expect(callees[0]!.snapshot.truncated).toBe(false);
  });

  it("finds #private methods with or without the # prefix", () => {
    const byBareName = findFunction(ps, "compute", new Set());
    expect(byBareName!.relativeFile).toBe("klass.ts");
    const relations = getRelations(ps, byBareName!);
    expect(relations!.callers.map((c) => c.name)).toEqual(["render"]);
  });

  it("prefers declarations in changed files when ambiguous", () => {
    const preferred = findFunction(ps, "target", new Set(["main.ts"]));
    expect(preferred!.relativeFile).toBe("main.ts");
  });
});

describe("definitionAt", () => {
  const ps = createProjectService(dir);
  const main = path.join(dir, "main.ts");
  const mainText = fileSnapshot(ps, "main.ts")!.lines;
  // Offset of a word's first occurrence on a 1-based line.
  const offsetOf = (line: number, word: string): number =>
    mainText.slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0) + mainText[line - 1]!.indexOf(word);

  it("resolves a cross-file call to the declaring function", () => {
    const def = definitionAt(ps, main, offsetOf(4, "helper"))!;
    expect(def.fileName).toBe(path.join(dir, "helper.ts"));
    expect([def.kind, def.external, def.nameLine, def.nameColumn, def.nameEndColumn]).toEqual([
      "function", false, 3, 16, 22,
    ]);
    expect([def.startLine, def.endLine]).toEqual([3, 5]);
  });

  it("resolves a parameter use to its declaration in the signature", () => {
    const def = definitionAt(ps, main, offsetOf(4, "x"))!;
    expect([def.kind, def.nameLine, def.nameColumn]).toEqual(["parameter", 3, 23]);
  });

  it("returns null on the declaration itself", () => {
    expect(definitionAt(ps, main, offsetOf(3, "target"))).toBeNull();
  });

  it("flags a lib.d.ts definition as external", () => {
    const def = definitionAt(ps, main, offsetOf(4, "Math"))!;
    expect(def.external).toBe(true);
    expect(def.fileName.endsWith(".d.ts")).toBe(true);
  });
});

describe("incomingCallsAt / referencesAt", () => {
  const ps = createProjectService(dir);
  const mainText = fileSnapshot(ps, "main.ts")!.lines;
  const helperText = fileSnapshot(ps, "helper.ts")!.lines;
  const offsetIn = (lines: string[], line: number, word: string): number =>
    lines.slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0) + lines[line - 1]!.indexOf(word);

  it("lists each call site with the function it sits in", () => {
    const calls = incomingCallsAt(ps, path.join(dir, "main.ts"), offsetIn(mainText, 3, "target"))!;
    const byCaller = calls.map((c) => [c.enclosing?.name, path.basename(c.fileName), c.line, c.snippet]);
    expect(byCaller).toEqual(
      expect.arrayContaining([
        ["useTarget", "consumer.ts", 4, "return target(1) + target(2);"],
        ["bigCaller", "big.ts", 74, "return target(3);"],
      ]),
    );
    // Two calls on one line are two sites.
    expect(calls.filter((c) => c.line === 4)).toHaveLength(2);
    const use = calls.find((c) => c.enclosing?.name === "useTarget")!.enclosing!;
    expect([use.kind, use.line, use.column, use.startLine, use.endLine]).toEqual(["function", 3, 16, 3, 5]);
  });

  it("returns null for a non-callable, so the caller falls back to references", () => {
    const helperFile = path.join(dir, "helper.ts");
    expect(incomingCallsAt(ps, helperFile, offsetIn(helperText, 1, "SCALE"))).toBeNull();
    const refs = referencesAt(ps, helperFile, offsetIn(helperText, 1, "SCALE"));
    expect(refs.map((r) => [r.enclosing?.name, r.line, r.startColumn, r.endColumn])).toEqual([
      ["helper", 4, 13, 18],
    ]);
  });
});

describe("fileSnapshot symbols", () => {
  const ps = createProjectService(dir);

  it("records where each declared name sits", () => {
    const widget = fileSnapshot(ps, "klass.ts")!.symbols.find((s) => s.name === "Widget")!;
    expect([widget.nameLine, widget.nameColumn, widget.nameEndColumn]).toEqual([1, 13, 19]);
  });

  it("nests methods under their class rather than listing them flat", () => {
    const symbols = fileSnapshot(ps, "klass.ts")!.symbols;
    expect(symbols.map((s) => s.name)).toEqual(["Widget"]);
    expect(symbols[0]!.children!.map((s) => `${s.kind}:${s.name}`)).toEqual(["method:render", "method:#compute"]);
    expect(fileSnapshot(ps, "main.ts")!.symbols[0]!.children).toBeUndefined();
  });
});
