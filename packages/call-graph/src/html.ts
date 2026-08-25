import { fileDiffRows, hunkRows, markIntraLine, renderDiffBlock, rowsWidth } from "./diffView.js";
import {
  escapeHtml as esc,
  languageOf,
  renderLine,
  tokenizeLines,
  type Language,
  type Mark,
  type Token,
} from "./highlight.js";
import type {
  CallGraphResult,
  DiffHunk,
  EmbeddedFile,
  FunctionSnapshot,
  RelatedFunction,
  SourceSegment,
  SymbolRange,
} from "./types.js";

/** Lines revealed per click of an expander, matching GitHub. */
const EXPAND_STEP = 20;

// ---------------------------------------------------------------------------
// Embedded file index

export interface FileEntry {
  key: string;
  lang: Language;
  lines: string[];
  tokens: Token[][];
  /** Per-line pre-highlighted HTML (no marks). */
  html: string[];
  symbols: SymbolRange[];
}

export type FileIndex = Map<string, FileEntry>;

export function buildFileIndex(files: EmbeddedFile[]): FileIndex {
  const index: FileIndex = new Map();
  for (const file of files) {
    const key = `${file.side}:${file.path}`;
    const lang = languageOf(file.path);
    const tokens = tokenizeLines(file.lines, lang);
    index.set(key, {
      key,
      lang,
      lines: file.lines,
      tokens,
      html: file.lines.map((line, i) => renderLine(line, tokens[i]!, [])),
      symbols: file.symbols,
    });
  }
  return index;
}

function symbolLabel(symbol: SymbolRange): string {
  return ["class", "interface", "enum", "namespace"].includes(symbol.kind)
    ? `${symbol.kind} ${symbol.name}`
    : `${symbol.name}()`;
}

/** Outermost → innermost symbols containing a line: "class Ky › #retry()". */
function crumbFor(symbols: SymbolRange[], line: number): string {
  return symbols
    .filter((s) => s.startLine <= line && s.endLine >= line)
    .sort((a, b) => b.endLine - b.startLine - (a.endLine - a.startLine))
    .map((s) => esc(symbolLabel(s)))
    .join(" › ");
}

// ---------------------------------------------------------------------------
// Code blocks: line rows, expander gaps

export interface LineDecoration {
  /** Extra classes on the row, e.g. ["hl"] or ["diff-add"]. */
  cls?: string[];
  marks?: Mark[];
  /** PR-removed line texts rendered (red, "−" gutter) above this line. */
  deletedBefore?: string[];
}

export type Decorations = Map<number, LineDecoration>;

export function lineRow(
  lineNumber: number | string,
  width: number,
  contentHtml: string,
  cls: string[] = [],
): string {
  const classes = ["line", ...cls].join(" ");
  return `<span class="${classes}"><span class="lineno">${String(lineNumber).padStart(width)}</span>${contentHtml}</span>`;
}

/** A gap bar with nothing to expand into: the file's text is not on the page. */
export function staticGapRow(count: number): string {
  if (count <= 0) return "";
  return `<div class="gap static"><span class="gap-count">⋯ ${count} hidden lines</span></div>`;
}

/** GitHub-style expander: ▲ reveals the gap's bottom, ▼ its top. */
export function gapRow(entry: FileEntry, from: number, to: number): string {
  const count = to - from + 1;
  if (count <= 0) return "";
  const crumb = crumbFor(entry.symbols, Math.min(to + 1, entry.lines.length));
  const buttons =
    count <= EXPAND_STEP
      ? '<button class="gap-btn gap-all" title="Expand all">↕</button>'
      : '<button class="gap-btn gap-up" title="Expand up">▲</button><button class="gap-btn gap-down" title="Expand down">▼</button>';
  return `<div class="gap" data-key="${esc(entry.key)}" data-from="${from}" data-to="${to}"><span class="gap-btns">${buttons}</span><span class="gap-count">⋯ ${count} hidden lines</span>${
    crumb ? `<span class="gap-crumb">${crumb}</span>` : ""
  }</div>`;
}

interface BlockOptions {
  /** Embedded file backing this block; enables expanders when `gaps`. */
  entry?: FileEntry | undefined;
  gaps?: boolean;
  decorations?: Decorations;
  /** Tokenizer language for non-embedded segments (default from entry, else ts). */
  lang?: Language;
}

/** Render source segments as a code block, with expander gaps between/around. */
export function renderCodeBlock(segments: SourceSegment[], opts: BlockOptions): string {
  const { entry, decorations } = opts;
  const gaps = Boolean(opts.gaps && entry);
  const width = entry
    ? String(entry.lines.length).length
    : String(Math.max(...segments.map((s) => s.startLine + s.lines.length - 1), 1)).length;

  const rows: string[] = [];
  let previousEnd = 0;
  for (const segment of segments) {
    if (gaps && entry) {
      rows.push(gapRow(entry, previousEnd + 1, segment.startLine - 1));
    } else if (previousEnd > 0 && segment.startLine > previousEnd + 1) {
      rows.push(
        `<span class="line elide">${" ".repeat(width)}⋯ ${segment.startLine - previousEnd - 1} lines omitted ⋯</span>`,
      );
    }
    const lang = opts.lang ?? entry?.lang ?? "ts";
    const localTokens = entry ? null : tokenizeLines(segment.lines, lang);
    segment.lines.forEach((text, i) => {
      const n = segment.startLine + i;
      const deco = decorations?.get(n);
      for (const deleted of deco?.deletedBefore ?? []) {
        const html = renderLine(deleted, tokenizeLines([deleted], lang)[0]!, []);
        rows.push(lineRow("−", width, html, ["diff-del"]));
      }
      const content =
        entry && !deco?.marks
          ? (entry.html[n - 1] ?? esc(text))
          : renderLine(
              text,
              entry ? (entry.tokens[n - 1] ?? []) : localTokens![i]!,
              deco?.marks ?? [],
            );
      rows.push(lineRow(n, width, content, deco?.cls ?? []));
    });
    previousEnd = segment.startLine + segment.lines.length - 1;
  }
  if (gaps && entry && previousEnd < entry.lines.length) {
    rows.push(gapRow(entry, previousEnd + 1, entry.lines.length));
  }
  return `<pre class="source" data-w="${width}">${rows.join("")}</pre>`;
}

// ---------------------------------------------------------------------------
// Diff hunks (target card): unified view with expander gaps around

/** Context shown around each change in a hunks-only block, like `git diff`. */
const HUNK_CONTEXT = 3;

/** A function's hunks as one unified diff, with expandable context when the file is embedded. */
export function renderHunksBlock(
  hunks: DiffHunk[],
  entry: FileEntry | undefined,
  lang?: Language,
): string {
  if (!hunks.length) return "";
  const rows = entry ? fileDiffRows(entry.lines, hunks, { context: HUNK_CONTEXT }) : hunkRows(hunks);
  markIntraLine(rows);
  return renderDiffBlock(rows, { width: rowsWidth(rows, entry), lang: lang ?? entry?.lang ?? "ts", entry });
}

// ---------------------------------------------------------------------------
// Snapshots (one side of a caller/callee/target)

interface SnapshotDisplay {
  /** Highlight the call to the target inside the source (callers). */
  highlightCallSites?: boolean;
  /** List call sites separately — they live in another file (callees). */
  listCallSites?: boolean;
  /** Location only, no source body (the target — its hunks show the change). */
  hideSource?: boolean;
  /** When diff hunks exist, show only them — no before/after source (callees). */
  diffOnly?: boolean;
}

/** Same code, ignoring line-number shifts from edits elsewhere in the file. */
function sameSource(a: FunctionSnapshot, b: FunctionSnapshot): boolean {
  return (
    a.file === b.file &&
    a.source.length === b.source.length &&
    a.source.every(
      (segment, i) => segment.lines.join("\n") === b.source[i]!.lines.join("\n"),
    )
  );
}

function callSiteDecorations(snapshot: FunctionSnapshot): Decorations {
  const decorations: Decorations = new Map();
  for (const site of snapshot.callSites) {
    const marks: Mark[] =
      site.startColumn !== undefined && site.endColumn !== undefined
        ? [{ start: site.startColumn, end: site.endColumn, cls: "callsite" }]
        : [];
    decorations.set(site.line, { cls: ["hl"], marks });
  }
  return decorations;
}

function renderSnapshot(
  side: "before" | "after" | "both",
  snapshot: FunctionSnapshot | null,
  index: FileIndex,
  display: SnapshotDisplay = {},
): string {
  if (!snapshot) {
    return `<div class="side side-${side}"><span class="missing">not present ${side === "before" ? "before" : "after"} the PR</span></div>`;
  }
  const entry = index.get(`${side === "both" ? "after" : side}:${snapshot.file}`);
  const sites = display.listCallSites
    ? snapshot.callSites
        .map(
          (s) =>
            `<li><span class="loc">L${s.line}</span> <code>${esc(s.snippet)}</code></li>`,
        )
        .join("")
    : "";
  const body = display.hideSource
    ? ""
    : renderCodeBlock(snapshot.source, {
        entry,
        gaps: true,
        lang: languageOf(snapshot.file),
        decorations: display.highlightCallSites
          ? callSiteDecorations(snapshot)
          : new Map(),
      });
  return `<div class="side side-${side}">
    <div class="side-loc"><code>${esc(snapshot.file)}:${snapshot.startLine}–${snapshot.endLine}</code>${
      snapshot.truncated ? ' <span class="badge">elided</span>' : ""
    }</div>
    ${sites ? `<div class="call-sites-label">call sites in target</div><ul class="call-sites">${sites}</ul>` : ""}
    ${body}
  </div>`;
}

/** Render before/after; a function identical on both sides gets one block. */
function renderSides(
  before: FunctionSnapshot | null,
  after: FunctionSnapshot | null,
  index: FileIndex,
  display: SnapshotDisplay,
): string {
  if (before && after && sameSource(before, after)) {
    return renderSnapshot("both", after, index, display);
  }
  return (
    renderSnapshot("before", before, index, display) +
    renderSnapshot("after", after, index, display)
  );
}

// ---------------------------------------------------------------------------
// Related functions and groups

export function presenceBadge(
  fn: Pick<RelatedFunction, "presence" | "changedInPr" | "renamedFrom">,
): string {
  if (fn.renamedFrom) {
    return `<span class="badge renamed">renamed from ${esc(fn.renamedFrom)}</span>`;
  }
  if (fn.presence === "both") {
    return fn.changedInPr
      ? '<span class="badge changed">changed</span>'
      : '<span class="badge">unchanged</span>';
  }
  return `<span class="badge ${fn.presence === "after" ? "added" : "removed"}">${
    fn.presence === "after" ? "added in PR" : "removed in PR"
  }</span>`;
}

function renderRelated(
  fn: RelatedFunction,
  index: FileIndex,
  display: SnapshotDisplay,
): string {
  const diffOnly = Boolean(display.diffOnly && fn.hunks.length);
  return `<details class="fn presence-${fn.presence}${fn.changedInPr ? " is-changed" : ""}">
    <summary><code class="fn-name">${esc(fn.name)}</code> <code class="fn-file">${esc(fn.file)}</code> ${presenceBadge(fn)}</summary>
    <div class="fn-body">
      ${diffOnly ? "" : renderSides(fn.before, fn.after, index, display)}
      ${fn.hunks.length ? `<div class="hunks">${renderHunksBlock(fn.hunks, undefined, languageOf(fn.file))}</div>` : '<p class="missing">no diff hunks touch this function</p>'}
    </div>
  </details>`;
}

function renderGroup(
  title: string,
  kind: "callers" | "callees",
  fns: RelatedFunction[],
  index: FileIndex,
): string {
  const display: SnapshotDisplay =
    kind === "callers"
      ? { highlightCallSites: true }
      : { listCallSites: true, diffOnly: true };
  const items = fns.length
    ? fns.map((fn) => renderRelated(fn, index, display)).join("\n")
    : '<p class="missing">none found</p>';
  return `<section class="group group-${kind}">
    <h2>${title} <span class="count">${fns.length}</span></h2>
    ${items}
  </section>`;
}

// ---------------------------------------------------------------------------
// Page chrome: CSS, embedded data, client JS

export const CSS = `
  :root {
    color-scheme: light dark;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace;
    --bg: #fafafa; --panel: #ffffff; --panel-2: #f4f4f5;
    --ink: #18181b; --ink-soft: #52525b; --ink-faint: #a1a1aa;
    --line-c: #e4e4e7;
    --accent: #4f46e5; --accent-ink: #ffffff; --accent-soft: #eef0fe;
    --add-bg: rgba(22, 163, 74, 0.09); --add-edge: #16a34a;
    --del-bg: rgba(220, 38, 38, 0.08); --del-edge: #dc2626;
    --callsite-bg: rgba(79, 70, 229, 0.10);
    --add-inner: rgba(22, 163, 74, 0.28); --del-inner: rgba(220, 38, 38, 0.26);
    --tok-kw: #9333ea; --tok-str: #15803d; --tok-com: #a1a1aa;
    --tok-num: #b45309; --tok-fn: #4f46e5; --tok-type: #0e7490; --tok-lit: #b45309;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0c0d10; --panel: #131418; --panel-2: #1a1c22;
      --ink: #e7e8ea; --ink-soft: #9ea1a8; --ink-faint: #5c5f66;
      --line-c: #24262d;
      --accent: #818cf8; --accent-ink: #0c0d10; --accent-soft: #1e2040;
      --add-bg: rgba(74, 222, 128, 0.08); --add-edge: #4ade80;
      --del-bg: rgba(248, 113, 113, 0.08); --del-edge: #f87171;
      --callsite-bg: rgba(129, 140, 248, 0.14);
      --add-inner: rgba(74, 222, 128, 0.28); --del-inner: rgba(248, 113, 113, 0.26);
      --tok-kw: #c084fc; --tok-str: #86efac; --tok-com: #5c5f66;
      --tok-num: #fbbf24; --tok-fn: #a5b4fc; --tok-type: #67e8f9; --tok-lit: #fbbf24;
    }
  }
  .tok-kw { color: var(--tok-kw); } .tok-str { color: var(--tok-str); }
  .tok-com { color: var(--tok-com); font-style: italic; } .tok-num { color: var(--tok-num); }
  .tok-fn { color: var(--tok-fn); } .tok-type { color: var(--tok-type); }
  .tok-lit { color: var(--tok-lit); }
  body { margin: 0 auto; padding: 1.5rem 1rem 4rem; background: var(--bg); color: var(--ink);
         font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
  code { font-family: var(--mono); font-size: 0.9em; }
  header h1 { margin-bottom: 0.2rem; letter-spacing: -0.015em; }
  header .meta { color: var(--ink-soft); font-size: 0.9rem; }
  header a { color: inherit; }
  .controls { display: flex; gap: 0.5rem; align-items: center; margin: 1rem 0; flex-wrap: wrap; }
  .controls button { padding: 0.3rem 0.8rem; cursor: pointer; border: 1px solid var(--line-c);
                     border-radius: 6px; background: var(--panel); color: var(--ink-soft); font: inherit; }
  .controls button:hover { color: var(--accent); border-color: var(--accent); }
  .controls button[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
  section.group h2 { border-bottom: 1px solid var(--line-c); padding-bottom: 0.3rem; }
  .count { color: var(--ink-faint); font-size: 0.8em; }
  details.fn { border: 1px solid var(--line-c); border-radius: 8px; margin: 0.5rem 0; background: var(--panel); }
  details.fn summary { padding: 0.5rem 0.8rem; cursor: pointer; display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap; }
  details.fn .fn-name { font-weight: 700; }
  details.fn .fn-file { color: var(--ink-faint); }
  .fn-body { padding: 0 0.8rem 0.8rem; }
  .badge { font-size: 0.68rem; font-weight: 500; padding: 0.14rem 0.55rem; border-radius: 999px;
           background: var(--panel-2); color: var(--ink-soft); border: 1px solid var(--line-c);
           font-variant-numeric: tabular-nums; }
  .badge.changed { background: rgba(230, 160, 0, 0.14); color: var(--tok-num); border-color: transparent; }
  .badge.renamed { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
  .badge.added { background: var(--add-bg); color: var(--add-edge); border-color: transparent; }
  .badge.removed { background: var(--del-bg); color: var(--del-edge); border-color: transparent; }
  .side { margin: 0.4rem 0; padding: 0.4rem 0.6rem; border-left: 3px solid var(--line-c); }
  .side-before { border-left-color: var(--del-edge); }
  .side-after { border-left-color: var(--add-edge); }
  .side::before { display: block; font-size: 0.7rem; text-transform: uppercase; color: var(--ink-faint); }
  .side-before::before { content: "before"; }
  .side-after::before { content: "after"; }
  .side-both::before { content: "before & after — identical"; }
  .call-sites { margin: 0.3rem 0 0; padding-left: 1.2rem; }
  .call-sites-label { font-size: 0.7rem; text-transform: uppercase; color: var(--ink-faint); margin-top: 0.4rem; }
  .loc { color: var(--ink-faint); font-size: 0.8em; }
  .missing { color: var(--ink-faint); font-style: italic; }
  pre.source { overflow-x: auto; background: var(--panel); border: 1px solid var(--line-c); border-radius: 8px; padding: 0.35rem 0; margin: 0.5rem 0 0.2rem; line-height: 1.65; font-family: var(--mono); font-size: 0.78rem; }
  .source .line { display: block; padding: 0 0.9rem; }
  .source .lineno { display: inline-block; color: var(--ink-faint); margin-right: 1.1rem; user-select: none; white-space: pre; }
  .source .line.hl { background: rgba(230,160,0,0.12); }
  .source .line.diff-add { background: var(--add-bg); }
  .source .line.diff-del { background: var(--del-bg); }
  .source .line.diff-del .lineno { color: var(--del-edge); }
  .source .line.diff-add .lineno { color: var(--add-edge); }
  /* Within a changed pair of lines, the words that actually differ. */
  .source .diff-add-inner { background: var(--add-inner); border-radius: 2px; }
  .source .diff-del-inner { background: var(--del-inner); border-radius: 2px; }
  /* The declaration a panel is about, marked along its left edge so it stands
     out from the context around it without competing with the diff colors. */
  .source .line.in-focus { box-shadow: inset 3px 0 0 var(--accent); }
  .source .line.elide { color: var(--ink-faint); font-style: italic; }
  .callsite { background: var(--callsite-bg); border-radius: 4px; padding: 0.05rem 0; }
  .csite { color: var(--accent); background: var(--callsite-bg); border-radius: 4px;
           padding: 0.08em 0.25em; cursor: pointer; transition: background 0.12s; }
  .csite:hover { background: var(--accent); }
  .csite:hover, .csite:hover * { color: var(--accent-ink); }
  .csite.active { outline: 2px solid var(--accent); }
  .gap { display: flex; align-items: center; gap: 0.8rem; background: var(--panel-2);
         border-top: 1px solid var(--line-c); border-bottom: 1px solid var(--line-c);
         padding: 0.22rem 0.9rem; font-family: ui-sans-serif, system-ui, sans-serif;
         font-size: 0.68rem; color: var(--ink-faint); }
  .gap.static { cursor: default; }
  .gap-btns { display: inline-flex; gap: 2px; }
  .gap-btn { border: none; background: none; color: var(--accent); cursor: pointer; font-size: 0.7rem; padding: 0.05rem 0.3rem; border-radius: 4px; }
  .gap-btn:hover { background: var(--accent-soft); }
  .gap-count { color: var(--ink-faint); }
  .gap-crumb { color: var(--ink-soft); font-family: var(--mono); margin-left: auto; }
  .target-card { border: 1px solid var(--line-c); border-radius: 12px; padding: 0.8rem 1rem; margin-top: 1.5rem; background: var(--panel); }
  .target-card h2 { margin: 0 0 0.4rem; }
  body[data-view="before"] .side-after, body[data-view="after"] .side-before { display: none; }
`;

/** Expander behavior shared by all layouts. Written injection-safe (no template literals). */
export const GAP_JS = `
  var RD = JSON.parse(document.getElementById("render-data").textContent);
  var STEP = RD.step;
  function crumbFor(file, line) {
    var parts = [];
    for (var i = 0; i < file.symbols.length; i++) {
      var s = file.symbols[i];
      if (s[1] <= line && s[2] >= line) parts.push({ label: s[0], size: s[2] - s[1] });
    }
    parts.sort(function (a, b) { return b.size - a.size; });
    return parts.map(function (p) { return p.label; }).join(" \\u203a ");
  }
  function rowHtml(file, n, w) {
    var num = String(n); while (num.length < w) num = " " + num;
    return '<span class="line"><span class="lineno">' + num + "</span>" + (file.html[n - 1] || "") + "</span>";
  }
  function gapInner(file, from, to) {
    var count = to - from + 1;
    var buttons = count <= STEP
      ? '<button class="gap-btn gap-all" title="Expand all">\\u2195</button>'
      : '<button class="gap-btn gap-up" title="Expand up">\\u25b2</button><button class="gap-btn gap-down" title="Expand down">\\u25bc</button>';
    var crumb = crumbFor(file, Math.min(to + 1, file.count));
    return '<span class="gap-btns">' + buttons + '</span><span class="gap-count">\\u22ef ' + count + " hidden lines</span>" +
      (crumb ? '<span class="gap-crumb">' + crumb + "</span>" : "");
  }
  document.addEventListener("click", function (e) {
    var btn = e.target.closest(".gap-btn");
    if (!btn) return;
    var gap = btn.closest(".gap");
    var file = RD.files[gap.dataset.key];
    if (!file) return;
    var from = Number(gap.dataset.from), to = Number(gap.dataset.to);
    var w = Number(gap.closest("pre").dataset.w);
    var rows = "";
    if (btn.classList.contains("gap-all") || to - from + 1 <= STEP) {
      for (var n = from; n <= to; n++) rows += rowHtml(file, n, w);
      gap.insertAdjacentHTML("beforebegin", rows);
      gap.remove();
      return;
    }
    if (btn.classList.contains("gap-down")) {
      for (var n2 = from; n2 < from + STEP; n2++) rows += rowHtml(file, n2, w);
      gap.insertAdjacentHTML("beforebegin", rows);
      from += STEP;
    } else {
      for (var n3 = to - STEP + 1; n3 <= to; n3++) rows += rowHtml(file, n3, w);
      gap.insertAdjacentHTML("afterend", rows);
      to -= STEP;
    }
    gap.dataset.from = String(from);
    gap.dataset.to = String(to);
    gap.innerHTML = gapInner(file, from, to);
  });
`;

export function renderDataBlob(index: FileIndex): string {
  const files: Record<string, unknown> = {};
  for (const [key, entry] of index) {
    files[key] = {
      html: entry.html,
      count: entry.lines.length,
      symbols: entry.symbols.map((s) => [symbolLabel(s), s.startLine, s.endLine]),
    };
  }
  return JSON.stringify({ step: EXPAND_STEP, files }).replaceAll("</", "<\\/");
}

export interface PageMeta {
  prUrl: string;
  prTitle: string;
  functionName: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
}

export function pageHead(result: PageMeta, extraCss: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(result.functionName)} — PR call graph</title>
<style>${CSS}${extraCss}</style>`;
}

export function pageHeader(result: PageMeta): string {
  return `<header>
  <h1><code>${esc(result.functionName)}</code></h1>
  <p class="meta">
    <a href="${esc(result.prUrl)}">${esc(result.prTitle)}</a> ·
    ${esc(result.base.ref)} <code>${esc(result.base.sha.slice(0, 8))}</code> →
    <code>${esc(result.head.sha.slice(0, 8))}</code>
  </p>
</header>`;
}

export function dataScripts(result: unknown, index: FileIndex): string {
  return `<script type="application/json" id="call-graph-data">${JSON.stringify(result).replaceAll("</", "<\\/")}</script>
<script type="application/json" id="render-data">${renderDataBlob(index)}</script>`;
}

// ---------------------------------------------------------------------------
// Stacked layout (callers / target / callees, top to bottom)

/** Render an analysis result as a self-contained HTML page. */
export function renderCallGraphHtml(result: CallGraphResult): string {
  const index = buildFileIndex(result.files);
  const { target } = result;
  const targetEntry =
    index.get(`after:${target.after?.file ?? ""}`) ??
    index.get(`before:${target.before?.file ?? ""}`);

  return `<!doctype html>
<html lang="en">
<head>
${pageHead(result, "\n  body { max-width: 60rem; }")}
</head>
<body data-view="both">
${pageHeader(result)}

<div class="controls">
  <span>Show:</span>
  <button data-view="both" aria-pressed="true">Both</button>
  <button data-view="before" aria-pressed="false">Before</button>
  <button data-view="after" aria-pressed="false">After</button>
  <span style="flex:1"></span>
  <button id="expand-all">Expand all</button>
  <button id="collapse-all">Collapse all</button>
</div>

${renderGroup("Callers", "callers", result.callers, index)}

<section class="target-card">
  <h2>Target: <code>${esc(target.name)}</code>
    ${target.changedInPr ? '<span class="badge changed">changed</span>' : '<span class="badge">unchanged</span>'}
  </h2>
  ${renderSides(target.before, target.after, index, { hideSource: true })}
  ${target.hunks.length ? `<div class="hunks">${renderHunksBlock(target.hunks, targetEntry)}</div>` : ""}
</section>

${renderGroup("Callees", "callees", result.callees, index)}

${dataScripts(result, index)}
<script>
${GAP_JS}
  for (const button of document.querySelectorAll('.controls button[data-view]')) {
    button.addEventListener("click", () => {
      document.body.dataset.view = button.dataset.view;
      for (const other of document.querySelectorAll('.controls button[data-view]')) {
        other.setAttribute("aria-pressed", String(other === button));
      }
    });
  }
  const setAll = (open) => {
    for (const details of document.querySelectorAll("details.fn")) details.open = open;
  };
  document.getElementById("expand-all").addEventListener("click", () => setAll(true));
  document.getElementById("collapse-all").addEventListener("click", () => setAll(false));
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Columns layout (callers | target | selected callee)

/** New-file line numbers added by these hunks. */
export function addedLines(hunks: DiffHunk[]): Set<number> {
  const added = new Set<number>();
  for (const hunk of hunks) {
    let newN = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("-") || line.startsWith("\\")) continue;
      if (line.startsWith("+")) added.add(newN);
      newN++;
    }
  }
  return added;
}

/**
 * Removed line texts keyed by the new-file line they now sit above, so a
 * source block on the new side can interleave them as red deletion rows.
 */
export function deletedLinesByPosition(hunks: DiffHunk[]): Map<number, string[]> {
  const deleted = new Map<number, string[]>();
  for (const hunk of hunks) {
    let newN = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue;
      if (line.startsWith("-")) {
        const texts = deleted.get(newN) ?? [];
        texts.push(line.slice(1));
        deleted.set(newN, texts);
      } else {
        newN++;
      }
    }
  }
  return deleted;
}

/**
 * Tint PR-added lines and interleave PR-removed lines within a function's
 * span, so its new-side source reads as a unified diff.
 */
export function diffDecorations(
  decorations: Decorations,
  hunks: DiffHunk[],
  startLine: number,
  endLine: number,
): void {
  for (const line of addedLines(hunks)) {
    if (line >= startLine && line <= endLine) {
      decorations.set(line, { ...decorations.get(line), cls: ["diff-add"] });
    }
  }
  for (const [line, texts] of deletedLinesByPosition(hunks)) {
    if (line >= startLine && line <= endLine + 1) {
      decorations.set(line, { ...decorations.get(line), deletedBefore: texts });
    }
  }
}

function calleePanel(fn: RelatedFunction, i: number, index: FileIndex): string {
  return `<article class="callee-panel" data-idx="${i}" hidden>
    <h3><code class="fn-name">${esc(fn.name)}</code> <code class="fn-file">${esc(fn.file)}</code> ${presenceBadge(fn)}</h3>
    <p class="from-site missing"></p>
    ${
      fn.hunks.length
        ? `<div class="hunks">${renderHunksBlock(fn.hunks, undefined, languageOf(fn.file))}</div>`
        : renderSides(fn.before, fn.after, index, {})
    }
  </article>`;
}

/**
 * Three-column variant: callers | target | callee. Clicking a callee call
 * site in the target's source selects which callee shows on the right.
 */
export function renderCallGraphColumnsHtml(result: CallGraphResult): string {
  const index = buildFileIndex(result.files);
  const { target } = result;
  const side: "before" | "after" = target.after ? "after" : "before";
  const snapshot = target.after ?? target.before;
  if (!snapshot) throw new Error("target function has no source on either side");
  const entry = index.get(`${side}:${snapshot.file}`);

  // Decorate the target's source: PR-added lines tinted, PR-removed lines
  // interleaved in red, callee calls clickable.
  const decorations: Decorations = new Map();
  if (side === "after") {
    diffDecorations(decorations, target.hunks, snapshot.startLine, snapshot.endLine);
  }
  result.callees.forEach((callee, i) => {
    const sites = (side === "after" ? callee.after : callee.before)?.callSites ?? [];
    for (const site of sites) {
      if (site.startColumn === undefined || site.endColumn === undefined) continue;
      const existing = decorations.get(site.line) ?? {};
      decorations.set(site.line, {
        ...existing,
        marks: [
          ...(existing.marks ?? []),
          {
            start: site.startColumn,
            end: site.endColumn,
            cls: "csite",
            attrs: `data-callee="${i}" role="button" tabindex="0"`,
          },
        ],
      });
    }
  });

  const targetBlock = renderCodeBlock(snapshot.source, {
    entry,
    gaps: true,
    lang: languageOf(snapshot.file),
    decorations,
  });

  const columnsCss = `
  body.columns { max-width: none; padding: 1rem 1.2rem 2rem; }
  .cols {
    --rail: 34px; --gap: 12px;
    position: relative; display: flex; gap: var(--gap);
    height: calc(100vh - 130px); overflow: hidden;
  }
  .col {
    flex: none; width: calc((100% - var(--rail) - 2 * var(--gap)) / 2);
    height: 100%; overflow: auto; box-sizing: border-box;
    border: 1px solid rgba(128,128,128,0.3); border-radius: 8px; padding: 0.6rem 0.8rem;
  }
  /* iOS-style push: slide the strip left by animating the first column's margin. */
  .col-callers { margin-left: 0; transition: margin-left 0.4s cubic-bezier(0.32, 0.72, 0, 1); }
  .cols.slid .col-callers { margin-left: calc(1.5 * var(--rail) - 50%); }
  .col-callees { visibility: hidden; }
  .cols.has-selection .col-callees { visibility: visible; }
  .col > h2 { position: sticky; top: -0.6rem; margin: -0.6rem -0.8rem 0.5rem; padding: 0.6rem 0.8rem; background: Canvas; border-bottom: 1px solid rgba(128,128,128,0.3); font-size: 1rem; z-index: 1; }
  .placeholder { opacity: 0.6; font-style: italic; }
  .rail {
    position: absolute; top: 0; bottom: 0; width: var(--rail); z-index: 2;
    display: none; align-items: center; justify-content: center;
    border: 1px solid rgba(128,128,128,0.35); border-radius: 8px;
    background: Canvas; color: var(--accent); cursor: pointer;
    writing-mode: vertical-rl; text-orientation: mixed;
    font: 600 0.75rem ui-sans-serif, system-ui, sans-serif;
    letter-spacing: 0.05em; padding: 0.6rem 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .rail:hover { background: var(--callsite-bg); }
  .rail-left { left: 0; }
  .rail-right { right: 0; }
  .cols.slid .rail-left { display: flex; }
  .cols.has-selection:not(.slid) .rail-right { display: flex; }
`;

  return `<!doctype html>
<html lang="en">
<head>
${pageHead(result, columnsCss)}
</head>
<body class="columns" data-view="both">
${pageHeader(result)}

<div class="cols">
  <button class="rail rail-left" title="Back to callers">◀ Callers</button>
  <button class="rail rail-right" title="Show last callee">callee ▶</button>
  <section class="col col-callers">
    <h2>Callers <span class="count">${result.callers.length}</span></h2>
    ${
      result.callers.length
        ? result.callers
            .map((fn) => renderRelated(fn, index, { highlightCallSites: true }))
            .join("\n")
        : '<p class="missing">none found</p>'
    }
  </section>

  <section class="col col-target">
    <h2>Target: <code>${esc(target.name)}</code>
      ${target.changedInPr ? '<span class="badge changed">changed</span>' : '<span class="badge">unchanged</span>'}
    </h2>
    <div class="side-loc"><code>${esc(snapshot.file)}:${snapshot.startLine}–${snapshot.endLine}</code> <span class="badge">${side}</span></div>
    <p class="missing">click a highlighted call to open that callee →</p>
    ${targetBlock}
  </section>

  <section class="col col-callees">
    <h2>Callee</h2>
    <p class="placeholder">Click a call site in the target to show the callee here.</p>
    ${result.callees.map((fn, i) => calleePanel(fn, i, index)).join("\n")}
  </section>
</div>

${dataScripts(result, index)}
<script>
${GAP_JS}
  var cols = document.querySelector(".cols");
  var railRight = document.querySelector(".rail-right");
  document.addEventListener("click", function (e) {
    var site = e.target.closest(".csite");
    if (!site) return;
    var idx = site.dataset.callee;
    var panels = document.querySelectorAll(".callee-panel");
    for (var i = 0; i < panels.length; i++) panels[i].hidden = panels[i].dataset.idx !== idx;
    var placeholder = document.querySelector(".col-callees .placeholder");
    if (placeholder) placeholder.hidden = true;
    var active = document.querySelectorAll(".csite.active");
    for (var j = 0; j < active.length; j++) active[j].classList.remove("active");
    site.classList.add("active");
    var panel = document.querySelector('.callee-panel[data-idx="' + idx + '"]');
    var line = site.closest(".line");
    if (panel && line) {
      panel.querySelector(".from-site").textContent = "called from: " + line.textContent.trim();
    }
    var name = panel && panel.querySelector(".fn-name");
    if (name) railRight.textContent = name.textContent + " \\u25b6";
    cols.classList.add("has-selection", "slid");
    document.querySelector(".col-callees").scrollTop = 0;
  });
  document.querySelector(".rail-left").addEventListener("click", function () {
    cols.classList.remove("slid");
  });
  railRight.addEventListener("click", function () {
    cols.classList.add("slid");
  });
</script>
</body>
</html>
`;
}
