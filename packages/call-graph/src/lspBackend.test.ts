import { describe, expect, it } from "vitest";
import { isImportStatement, LspBackend } from "./lspBackend.js";

describe("LspBackend over a language server that dies", () => {
  // A "language server" that exits the moment it starts: every question
  // fails, but each one must fail on its own and leave the backend able to
  // try a fresh process, not wedge against the dead one.
  const config = {
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    languageId: "python",
    extensions: [".py"],
    declPattern: (name: string) => new RegExp(`def ${name}`),
  };

  it("reports the failure and spawns again on the next question", async () => {
    const backend = new LspBackend(process.cwd(), config);
    try {
      expect(backend.status()).toBe("idle");
      const ref = { fileName: `${process.cwd()}/nope.py`, line: 1, column: 0 };
      await expect(backend.definitionAt(ref)).rejects.toThrow(/exited/);
      expect(backend.status()).toBe("failed");
      // Not stuck: the second ask starts over rather than reusing the corpse.
      await expect(backend.definitionAt(ref)).rejects.toThrow(/exited/);
      expect(backend.status()).toBe("failed");
    } finally {
      backend.dispose();
      expect(backend.status()).toBe("idle");
    }
  }, 20_000);
});

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
