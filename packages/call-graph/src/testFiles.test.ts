import { describe, expect, it } from "vitest";
import { isTestFile } from "./testFiles.js";

describe("isTestFile", () => {
  it("matches TS/JS test and spec suffixes", () => {
    expect(isTestFile("src/retry.test.ts")).toBe(true);
    expect(isTestFile("src/retry.spec.tsx")).toBe(true);
    expect(isTestFile("src/retry.test.mjs")).toBe(true);
    expect(isTestFile("retry.test.js")).toBe(true);
  });

  it("matches Python test naming", () => {
    expect(isTestFile("pkg/test_retry.py")).toBe(true);
    expect(isTestFile("pkg/retry_test.py")).toBe(true);
    expect(isTestFile("test_retry.py")).toBe(true);
  });

  it("matches dedicated test directories", () => {
    expect(isTestFile("src/__tests__/retry.ts")).toBe(true);
    expect(isTestFile("tests/retry.py")).toBe(true);
    expect(isTestFile("src/test/retry.ts")).toBe(true);
  });

  it("leaves production files alone", () => {
    expect(isTestFile("src/retry.ts")).toBe(false);
    expect(isTestFile("src/latest/retry.ts")).toBe(false);
    expect(isTestFile("src/contests/entry.ts")).toBe(false);
    expect(isTestFile("src/protester.py")).toBe(false);
  });
});
