import { describe, expect, it } from "vitest";
import { sortFindings, type Finding } from "./index.js";

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "f1",
    reviewId: "r1",
    file: "a.ts",
    line: 1,
    severity: "minor",
    summary: "something",
    detail: "",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("sortFindings", () => {
  it("orders by severity, then file, then line", () => {
    const sorted = sortFindings([
      finding({ id: "1", severity: "nit", file: "b.ts", line: 3 }),
      finding({ id: "2", severity: "blocker", file: "z.ts", line: 9 }),
      finding({ id: "3", severity: "nit", file: "a.ts", line: 5 }),
      finding({ id: "4", severity: "nit", file: "a.ts", line: 2 }),
    ]);
    expect(sorted.map((f) => f.id)).toEqual(["2", "4", "3", "1"]);
  });
});
