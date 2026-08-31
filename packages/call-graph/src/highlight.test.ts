import { describe, expect, it } from "vitest";
import { identifiersOf, renderLine, tokenizeLines } from "./highlight.js";

function classesOf(lines: string[]): string[][] {
  return tokenizeLines(lines).map((tokens) => tokens.map((t) => t.cls));
}

describe("tokenizeLines", () => {
  it("classifies keywords, functions, strings, numbers, comments", () => {
    const [tokens] = classesOf(['const x = foo("hi", 42); // done']);
    expect(tokens).toEqual(["kw", "fn", "str", "num", "com"]);
  });

  it("treats #private names as functions", () => {
    const [tokens] = tokenizeLines(["this.#calc(1)"]);
    expect(tokens!.map((t) => t.cls)).toEqual(["lit", "fn", "num"]);
  });

  it("carries block comments across lines", () => {
    const classes = classesOf(["/* a", "still comment", "done */ const x = 1;"]);
    expect(classes[0]).toEqual(["com"]);
    expect(classes[1]).toEqual(["com"]);
    expect(classes[2]![0]).toBe("com");
    expect(classes[2]).toContain("kw");
  });

  it("carries template literals across lines", () => {
    const classes = classesOf(["const t = `line one", "line two`;"]);
    expect(classes[0]).toContain("str");
    expect(classes[1]![0]).toBe("str");
  });
});

describe("tokenizeLines (python)", () => {
  it("classifies def/keywords, # comments, and literals", () => {
    const [tokens] = tokenizeLines(["def leaf(n):  # add one"], "py");
    expect(tokens!.map((t) => t.cls)).toEqual(["kw", "fn", "com"]);
    const [line2] = tokenizeLines(["return None if not x else True"], "py");
    expect(line2!.map((t) => t.cls)).toEqual(["kw", "lit", "kw", "kw", "kw", "lit"]);
  });

  it("carries triple-quoted strings across lines", () => {
    const classes = tokenizeLines(['x = """docstring', "still text", 'done""" + 1'], "py").map(
      (tokens) => tokens.map((t) => t.cls),
    );
    expect(classes[0]).toContain("str");
    expect(classes[1]).toEqual(["str"]);
    expect(classes[2]![0]).toBe("str");
    expect(classes[2]).toContain("num");
  });
});

describe("identifiersOf", () => {
  it("reports every plain identifier with columns, skipping keywords and literals", () => {
    const [ids] = identifiersOf(['const total = compute(items, 42, "str x"); // note y']);
    expect(ids!.map((t) => [t.text, t.start, t.end])).toEqual([
      ["total", 6, 11],
      ["compute", 14, 21],
      ["items", 22, 27],
    ]);
  });

  it("excludes words inside strings and comments carried across lines", () => {
    const ids = identifiersOf(["/* skip me", "still skipped */ keep(this_one)"]);
    expect(ids[0]).toEqual([]);
    expect(ids[1]!.map((t) => t.text)).toEqual(["keep", "this_one"]);
  });

  it("handles Python self.attr and TS #private names", () => {
    const [py] = identifiersOf(["return self.value + other  # trailing"], "py");
    expect(py!.map((t) => t.text)).toEqual(["value", "other"]);
    const [ts] = identifiersOf(["this.#calc(1)"]);
    expect(ts!.map((t) => t.text)).toEqual(["#calc"]);
  });
});

describe("renderLine", () => {
  it("escapes HTML and wraps tokens", () => {
    const line = 'if (a < b) return "<b>";';
    const [tokens] = tokenizeLines([line]);
    const html = renderLine(line, tokens!);
    expect(html).toContain('<span class="tok-kw">if</span>');
    expect(html).toContain("a &lt; b");
    expect(html).toContain('<span class="tok-str">&quot;&lt;b&gt;&quot;</span>');
  });

  it("layers marks over tokens and carries attrs", () => {
    const line = "  return zap(1);";
    const [tokens] = tokenizeLines([line]);
    const html = renderLine(line, tokens!, [
      { start: 9, end: 12, cls: "csite", attrs: 'data-callee="3"' },
    ]);
    expect(html).toContain('<span class="tok-fn csite" data-callee="3">zap</span>');
  });
});
