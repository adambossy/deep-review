import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.js";

describe("renderMarkdown", () => {
  it("renders paragraphs, joining wrapped lines", () => {
    expect(renderMarkdown("one line\nsecond line\n\nnext para")).toBe(
      `<p class="md-p">one line second line</p>\n<p class="md-p">next para</p>`,
    );
  });

  it("shifts headings below the panel's own title", () => {
    expect(renderMarkdown("# Why\n")).toContain(`<h3 class="md-h">Why</h3>`);
    expect(renderMarkdown("### Detail\n")).toContain(`<h5 class="md-h">Detail</h5>`);
  });

  it("keeps fenced code verbatim, escaped, with its language", () => {
    const html = renderMarkdown("```ts\nconst a = <T>();\n```");
    expect(html).toBe(
      `<pre class="md-code" data-lang="ts"><code>const a = &lt;T&gt;();</code></pre>`,
    );
  });

  it("closes an unterminated fence at the end of the input", () => {
    expect(renderMarkdown("```\nstill code")).toBe(
      `<pre class="md-code"><code>still code</code></pre>`,
    );
  });

  it("renders bullet and numbered lists, nesting by indentation", () => {
    expect(renderMarkdown("- one\n  - deep\n- two")).toBe(
      `<ul class="md-list"><li>one <ul class="md-list"><li>deep</li></ul></li><li>two</li></ul>`,
    );
    expect(renderMarkdown("1. first\n2. second")).toBe(
      `<ol class="md-list"><li>first</li><li>second</li></ol>`,
    );
  });

  it("renders task boxes rather than form controls", () => {
    const html = renderMarkdown("- [x] done\n- [ ] pending");
    expect(html).toContain(`<span class="md-task done">☑</span> done`);
    expect(html).toContain(`<span class="md-task">☐</span> pending`);
    expect(html).not.toContain("<input");
  });

  it("renders quotes and rules", () => {
    expect(renderMarkdown("> quoted\n")).toBe(
      `<blockquote class="md-quote"><p class="md-p">quoted</p></blockquote>`,
    );
    expect(renderMarkdown("---")).toBe(`<hr class="md-rule">`);
  });

  it("renders inline code, emphasis, strikethrough, links and images", () => {
    expect(renderMarkdown("call `foo(a, b)` now")).toContain(
      `<code class="md-inline-code">foo(a, b)</code>`,
    );
    expect(renderMarkdown("**bold** and *soft* and _also_ and ~~gone~~")).toBe(
      `<p class="md-p"><strong>bold</strong> and <em>soft</em> and <em>also</em> and <del>gone</del></p>`,
    );
    expect(renderMarkdown("see [the PR](https://example.com/pr/1)")).toContain(
      `<a class="md-a" href="https://example.com/pr/1">the PR</a>`,
    );
    expect(renderMarkdown("![shot](https://example.com/a.png)")).toContain(
      `<img class="md-img" src="https://example.com/a.png" alt="shot" loading="lazy">`,
    );
  });

  it("links a bare URL once, not twice", () => {
    const html = renderMarkdown("ship it: https://example.com/x?a=1");
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(
      `<a class="md-a" href="https://example.com/x?a=1">https://example.com/x?a=1</a>`,
    );
  });

  it("leaves snake_case and multiplication alone", () => {
    expect(renderMarkdown("call max_graphs twice")).toBe(
      `<p class="md-p">call max_graphs twice</p>`,
    );
  });

  it("escapes HTML in the description, including inside code", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).toBe(
      `<p class="md-p">&lt;script&gt;alert(1)&lt;/script&gt;</p>`,
    );
    expect(renderMarkdown("`<b>`")).toContain(
      `<code class="md-inline-code">&lt;b&gt;</code>`,
    );
  });

  it("drops a link whose scheme is not one a description may use", () => {
    const html = renderMarkdown("[x](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href");
  });

  it("does not read a code span's contents as markup", () => {
    expect(renderMarkdown("`**not bold**` but **bold**")).toBe(
      `<p class="md-p"><code class="md-inline-code">**not bold**</code> but <strong>bold</strong></p>`,
    );
  });

  it("renders nothing for an empty description", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
