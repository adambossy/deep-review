import { escapeHtml as esc } from "./highlight.js";

export interface MarkdownOptions {
  /**
   * What a relative link resolves against — for a PR description, the PR's
   * own URL. GitHub renders `[2/3](../../pulls?q=…)` relative to the page
   * the description sits on, and this page is served from localhost, so
   * without a base such a link would point at nothing. Omitted, a relative
   * link stays plain text rather than pointing somewhere wrong.
   */
  baseUrl?: string | undefined;
}

/**
 * A small Markdown renderer, enough for what a pull request description
 * actually contains: headings, lists (nested, and with task boxes), fenced
 * and inline code, quotes, rules, links, images, and emphasis.
 *
 * Deliberately not a full CommonMark implementation — the input is one
 * author's prose, not arbitrary documents, and a dependency that renders
 * every corner of the spec would be a large amount of code to carry for one
 * panel. Anything unrecognized falls through as a paragraph, so the worst
 * case is prose that reads plainly rather than prose that disappears.
 */
export function renderMarkdown(
  source: string,
  options: MarkdownOptions = {},
): string {
  return renderBlocks(
    source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n"),
    options.baseUrl,
  );
}

/** Only what a description may link to; anything else is dropped. */
function safeUrl(url: string, baseUrl: string | undefined): string | null {
  const trimmed = url.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  // An in-page anchor stays as written: it addresses this page.
  if (trimmed.startsWith("#")) return trimmed;
  if (!baseUrl) return null;
  // A relative or root-relative link belongs to the repository the PR is
  // in, which is what the base says. A base that will not parse, or a
  // result that is not http(s), leaves the link as plain text.
  try {
    // GitHub resolves a description's relative links as if the PR page were
    // a directory, which is what makes its own `../../pulls` idiom land on
    // the repository's pull list rather than one level above it.
    const dir = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const resolved = new URL(trimmed, dir);
    return /^https?:$/.test(resolved.protocol) ? resolved.href : null;
  } catch {
    return null;
  }
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(?:```|~~~)\s*([\w+-]*)\s*$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBER = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

/** Indentation in spaces, counting a tab as two. */
function indentOf(text: string): number {
  const lead = /^\s*/.exec(text)?.[0] ?? "";
  return lead.replaceAll("\t", "  ").length;
}

function renderBlocks(lines: string[], baseUrl: string | undefined): string {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      // An unterminated fence runs to the end of the input rather than
      // swallowing the rest as prose.
      if (i < lines.length) i++;
      const lang = fence[1] ? ` data-lang="${esc(fence[1])}"` : "";
      out.push(
        `<pre class="md-code"${lang}><code>${esc(body.join("\n"))}</code></pre>`,
      );
      continue;
    }

    if (RULE.test(line)) {
      out.push(`<hr class="md-rule">`);
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      // Shifted down: the panel already carries the PR title as its
      // heading, so the description's own `#` sits under it.
      const level = Math.min(heading[1]!.length + 2, 6);
      out.push(`<h${level} class="md-h">${renderInline(heading[2]!, baseUrl)}</h${level}>`);
      i++;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const body: string[] = [quote[1]!];
      i++;
      while (i < lines.length) {
        const next = QUOTE.exec(lines[i]!);
        if (!next) break;
        body.push(next[1]!);
        i++;
      }
      out.push(`<blockquote class="md-quote">${renderBlocks(body, baseUrl)}</blockquote>`);
      continue;
    }

    if (BULLET.test(line) || NUMBER.test(line)) {
      const [html, next] = renderList(lines, i, baseUrl);
      out.push(html);
      i = next;
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length) {
      const next = lines[i]!;
      if (
        next.trim() === "" ||
        HEADING.test(next) ||
        FENCE.test(next) ||
        RULE.test(next) ||
        QUOTE.test(next) ||
        BULLET.test(next) ||
        NUMBER.test(next)
      ) {
        break;
      }
      paragraph.push(next.trim());
      i++;
    }
    out.push(`<p class="md-p">${renderInline(paragraph.join(" "), baseUrl)}</p>`);
  }

  return out.join("\n");
}

/**
 * One list, from `start` to the first line that is neither an item nor an
 * item's continuation. Items indented past the list's own marker become a
 * nested list inside the item above them.
 */
function renderList(
  lines: string[],
  start: number,
  baseUrl: string | undefined,
): [string, number] {
  const opener = BULLET.exec(lines[start]!);
  const ordered = opener === null;
  const baseIndent = indentOf(
    (opener ?? NUMBER.exec(lines[start]!)!)[1]!,
  );
  const items: string[][] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      // A blank line ends the list unless another item follows it.
      const following = lines[i + 1];
      if (
        following === undefined ||
        (!BULLET.test(following) && !NUMBER.test(following))
      ) {
        break;
      }
      i++;
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = NUMBER.exec(line);
    if (bullet ?? numbered) {
      const indent = indentOf((bullet ?? numbered)![1]!);
      if (indent < baseIndent) break;
      // A marker of the other kind at this level starts a list of its own.
      if (indent === baseIndent && (bullet === null) !== ordered) break;
      if (indent > baseIndent) {
        // Nested: hand the run to a recursive call and hang it off the item
        // above. An indented run with no item above it (a description that
        // starts mid-nesting) becomes a list on its own.
        const [nested, next] = renderList(lines, i, baseUrl);
        if (items.length === 0) items.push([]);
        items[items.length - 1]!.push(nested);
        i = next;
        continue;
      }
      items.push([bullet ? bullet[2]! : numbered![3]!]);
      i++;
      continue;
    }
    // A continuation line of the item above.
    if (items.length > 0 && indentOf(line) > baseIndent) {
      items[items.length - 1]!.push(line.trim());
      i++;
      continue;
    }
    break;
  }

  const tag = ordered ? "ol" : "ul";
  const body = items.map((parts) => `<li>${renderItem(parts, baseUrl)}</li>`).join("");
  return [`<${tag} class="md-list">${body}</${tag}>`, i];
}

/**
 * An item's own content: its text (with a task box where it has one), plus
 * any nested list already rendered to HTML.
 */
function renderItem(parts: string[], baseUrl: string | undefined): string {
  return parts
    .map((part) => {
      if (part.startsWith("<ul") || part.startsWith("<ol")) return part;
      const task = TASK.exec(part);
      if (!task) return renderInline(part, baseUrl);
      const done = task[1]!.toLowerCase() === "x";
      return `<span class="md-task${done ? " done" : ""}">${done ? "☑" : "☐"}</span> ${renderInline(task[2]!, baseUrl)}`;
    })
    .join(" ");
}

/**
 * Inline spans. Code spans are lifted out first and put back last, so their
 * contents are never read as emphasis or a link; every other pattern runs
 * over escaped text, which escaping leaves matchable.
 */
function renderInline(text: string, baseUrl: string | undefined): string {
  const code: string[] = [];
  const withoutCode = text.replace(/`([^`]+)`/g, (_all, body: string) => {
    code.push(`<code class="md-inline-code">${esc(body)}</code>`);
    return `%%code${code.length - 1}%%`;
  });

  let html = esc(withoutCode);

  html = html.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (all: string, alt: string, url: string) => {
      const href = safeUrl(url, baseUrl);
      return href
        ? `<img class="md-img" src="${esc(href)}" alt="${esc(alt)}" loading="lazy">`
        : all;
    },
  );
  html = html.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (all: string, label: string, url: string) => {
      const href = safeUrl(url, baseUrl);
      return href ? `<a class="md-a" href="${esc(href)}">${label}</a>` : all;
    },
  );
  // Bare URLs. A URL already inside an attribute the passes above wrote is
  // preceded by a quote rather than by whitespace, so it is left alone.
  html = html.replace(
    /(^|[\s(])(https?:\/\/[^\s<>()"]+)/g,
    (_all: string, lead: string, url: string) =>
      `${lead}<a class="md-a" href="${esc(url)}">${esc(url)}</a>`,
  );
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, "$1<em>$2</em>");
  html = html.replace(/(^|[^\w_])_([^_\n]+)_(?=[^\w_]|$)/g, "$1<em>$2</em>");

  return html.replace(
    /%%code(\d+)%%/g,
    (_all: string, i: string) => code[Number(i)]!,
  );
}
