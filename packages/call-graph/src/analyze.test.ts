import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { embedHeadFiles } from "./analyze.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "embed-head-test-"));
writeFileSync(path.join(dir, "main.ts"), "export class K {\n  run() {}\n}\n");
writeFileSync(path.join(dir, "README.md"), "# Title\n\nText.\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("embedHeadFiles", () => {
  it("embeds source with its symbol tree and other files as plain lines, skipping missing ones", async () => {
    const files = await embedHeadFiles(dir, ["main.ts", "README.md", "gone.ts", "../escape.ts"]);
    expect(files.map((f) => [f.side, f.path, f.lines.length])).toEqual([
      ["after", "main.ts", 4],
      ["after", "README.md", 4],
    ]);
    expect(files[0]!.symbols.map((s) => [s.name, s.children?.map((c) => c.name)])).toEqual([["K", ["run"]]]);
    expect(files[1]!.symbols).toEqual([]);
  });
});
