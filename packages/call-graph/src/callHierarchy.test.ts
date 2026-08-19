import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createProjectService,
  findFunction,
  getRelations,
} from "./callHierarchy.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "call-graph-test-"));

writeFileSync(
  path.join(dir, "main.ts"),
  `import { helper } from "./helper.js";

export function target(x: number): number {
  return helper(x) + 1;
}
`,
);
writeFileSync(
  path.join(dir, "helper.ts"),
  `export function helper(x: number): number {
  return x * 2;
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
    expect(source).toContain("return x * 2;");
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
