import { describe, expect, it } from "vitest";
import { isImportStatement } from "./lspBackend.js";

describe("isImportStatement", () => {
  const lines = [
    "from app.services.sandbox_ledger import (",
    "    SnapshotPointer,",
    "    latest_snapshot_pointer,  # restore pointer",
    ")",
    "import os, sys",
    "from x import y, \\",
    "    z",
    "",
    "def run():",
    "    pointer = latest_snapshot_pointer(1)",
    "    return partial(",
    "        latest_snapshot_pointer,",
    "    )",
  ];

  it("recognizes a one-line import", () => {
    expect(isImportStatement(lines, 4)).toBe(true);
  });

  it("recognizes every line of a parenthesized import", () => {
    expect([0, 1, 2, 3].map((n) => isImportStatement(lines, n))).toEqual([true, true, true, true]);
  });

  it("recognizes a backslash-continued import", () => {
    expect(isImportStatement(lines, 6)).toBe(true);
  });

  it("leaves a call and a callable passed inside parentheses alone", () => {
    expect(isImportStatement(lines, 9)).toBe(false);
    expect(isImportStatement(lines, 11)).toBe(false);
  });
});
