import { describe, expect, it } from "vitest";
import { renderCodePane } from "./codePane.js";
import type { DiffRow } from "./diffView.js";

const rows: DiffRow[] = [
  { kind: "ctx", n: 1, text: "# Title" },
  { kind: "ctx", n: 2, text: "Body." },
];

describe("renderCodePane", () => {
  it("wraps markdown panes, with the gutter width available for the hanging indent", () => {
    const html = renderCodePane({ file: "docs/notes.md", entry: undefined, rows, lang: "ts" });
    expect(html).toContain('<pre class="source wrap" data-w="1" style="--gutter:1">');
  });

  it("does not wrap non-markdown panes, so code keeps its horizontal scroll", () => {
    const html = renderCodePane({ file: "src/index.ts", entry: undefined, rows, lang: "ts" });
    expect(html).toContain('<pre class="source" data-w="1">');
    expect(html).not.toContain("wrap");
  });
});
