import {
  EXPLORER_CSS,
  EXPLORER_NAV_JS,
  renderPanel,
} from "./explorer.js";
import {
  escapeHtml as esc,
  languageOf,
  renderLine,
  tokenizeLines,
  type Mark,
} from "./highlight.js";
import {
  buildFileIndex,
  CSS,
  GAP_JS,
  gapRow,
  lineRow,
  renderDataBlob,
  type FileIndex,
} from "./html.js";
import type { CallPathResult, EmbeddedFile } from "./types.js";

/**
 * One fragment of a slice: a contiguous run of diff lines. Given
 * structurally rather than imported from the slicer package, so the two
 * analysis packages stay independent of each other.
 */
export interface SliceFragmentInput {
  id: string;
  file: string;
  summary: string;
  /** The `@@ ... @@` header of the hunk this fragment sits in. */
  hunkHeader: string;
  /** Raw diff lines, each still prefixed with " ", "+", "-", or "\\". */
  lines: string[];
  /** Head-side file line per entry of `lines`; null for removed lines. */
  newLineNumbers: (number | null)[];
  /**
   * The fragment's extent in the head-side file, used to place it among its
   * file's other fragments and to work out how much context surrounds it.
   * A fragment that only removes lines has no extent, and is marked by
   * `headEnd === headStart - 1` — it sits between two lines rather than on
   * any of them.
   */
  headStart: number;
  headEnd: number;
}

export interface SliceInput {
  id: string;
  title: string;
  summary: string;
  rationale: string;
  target?: { file: string; name: string } | undefined;
  fragments: SliceFragmentInput[];
  /**
   * The walked call graph rooted at this slice's target, when one was named
   * and the analysis succeeded. Without it the slice has no horizontal
   * dimension — its diff is all there is to see.
   */
  graph?: CallPathResult | undefined;
}

export interface SliceExplorerInput {
  prUrl: string;
  prTitle: string;
  repo: string;
  number: number;
  overview: string;
  slices: SliceInput[];
  /**
   * Head-side text of every file the slices touch. This is what lets a
   * file's fragments be shown as one continuous stretch of the file, with
   * real context between them and expanders over what stays hidden. A file
   * missing here (one the PR deleted, say) falls back to fragment-by-
   * fragment rendering.
   */
  files: EmbeddedFile[];
}

/** Occurrences of a graph symbol in one line of source, as tappable marks. */
function symbolMarks(
  content: string,
  symbols: { name: string; nodeId: string }[],
): Mark[] {
  const marks: Mark[] = [];
  for (const symbol of symbols) {
    let from = 0;
    for (;;) {
      const at = content.indexOf(symbol.name, from);
      if (at < 0) break;
      from = at + symbol.name.length;
      const before = content[at - 1] ?? " ";
      const after = content[from] ?? " ";
      // Whole-word only: `retry` must not light up inside `retryDelay`.
      if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) {
        marks.push({
          start: at,
          end: from,
          cls: "csite",
          attrs: `data-target="${esc(symbol.nodeId)}" role="button" tabindex="0"`,
        });
      }
    }
  }
  return marks.sort((a, b) => a.start - b.start);
}

/** Lines of the head-side file shown either side of a fragment. */
const FRAGMENT_CONTEXT = 5;

type Symbols = { name: string; nodeId: string }[];

/** The fragment's own diff rows: additions tinted, removals kept in place. */
function fragmentRows(
  fragment: SliceFragmentInput,
  width: number,
  symbols: Symbols,
): string[] {
  const lang = languageOf(fragment.file);
  const contents = fragment.lines.map((l) => l.slice(1));
  const tokens = tokenizeLines(contents, lang);

  return fragment.lines.map((line, i) => {
    if (line.startsWith("\\")) {
      return lineRow("", width, esc(line));
    }
    const html = renderLine(
      contents[i]!,
      tokens[i]!,
      symbolMarks(contents[i]!, symbols),
    );
    if (line.startsWith("-")) return lineRow("−", width, html, ["diff-del"]);
    return lineRow(
      fragment.newLineNumbers[i] ?? "",
      width,
      html,
      line.startsWith("+") ? ["diff-add"] : [],
    );
  });
}

/**
 * A marker where the fragment's lines begin, naming it so a row on screen
 * can be traced back to the slice JSON. The fragment's own one-line summary
 * is deliberately not shown: at this density it competed with the code for
 * attention. It stays in the data for another use.
 */
function fragmentNote(fragment: SliceFragmentInput, width: number): string {
  return `<span class="line frag-note"><span class="lineno">${" ".repeat(width)}</span><code class="frag-id">${esc(fragment.id)}</code></span>`;
}

/**
 * Every fragment a slice has in one file, rendered as one continuous stretch
 * of that file: each fragment surrounded by real context, the runs between
 * them collapsed behind expanders. Reading a file's changes should not mean
 * reassembling them from separate boxes.
 */
function renderFileBlock(
  file: string,
  fragments: SliceFragmentInput[],
  entry: ReturnType<FileIndex["get"]>,
  symbols: Symbols,
): string {
  // Without the file's text there is no context to show and nothing to
  // expand into, so each fragment stands alone.
  if (!entry) {
    const width = 4;
    const rows = fragments.flatMap((f) => [
      `<span class="line hunk-header">${esc(f.hunkHeader)}</span>`,
      fragmentNote(f, width),
      ...fragmentRows(f, width, symbols),
    ]);
    return `<div class="file-block"><div class="file-head"><code>${esc(file)}</code></div><pre class="source" data-w="${width}">${rows.join("")}</pre></div>`;
  }

  const width = String(entry.lines.length).length;
  const ordered = [...fragments].sort(
    (a, b) => a.headStart - b.headStart || a.headEnd - b.headEnd,
  );
  const rows: string[] = [];
  /** Last head-side line already emitted; nothing may be emitted twice. */
  let cursor = 0;

  const contextRows = (from: number, to: number): void => {
    for (let n = Math.max(from, 1); n <= Math.min(to, entry.lines.length); n++) {
      const marks = symbolMarks(entry.lines[n - 1] ?? "", symbols);
      const html = marks.length
        ? renderLine(entry.lines[n - 1] ?? "", entry.tokens[n - 1] ?? [], marks)
        : (entry.html[n - 1] ?? "");
      rows.push(lineRow(n, width, html));
      cursor = Math.max(cursor, n);
    }
  };

  ordered.forEach((fragment, i) => {
    const wanted = Math.max(1, fragment.headStart - FRAGMENT_CONTEXT);
    if (wanted > cursor + 1) {
      rows.push(gapRow(entry, cursor + 1, wanted - 1));
      cursor = wanted - 1;
    }
    contextRows(cursor + 1, fragment.headStart - 1);
    rows.push(fragmentNote(fragment, width));
    rows.push(...fragmentRows(fragment, width, symbols));
    cursor = Math.max(cursor, fragment.headEnd);

    // Trailing context, stopping short of the next fragment's own leading
    // context so the two never render the same line twice.
    const next = ordered[i + 1];
    const limit = Math.min(
      cursor + FRAGMENT_CONTEXT,
      next ? next.headStart - 1 : entry.lines.length,
    );
    contextRows(cursor + 1, limit);
  });

  if (cursor < entry.lines.length) {
    rows.push(gapRow(entry, cursor + 1, entry.lines.length));
  }

  return `<div class="file-block">
    <div class="file-head"><code>${esc(file)}</code></div>
    <pre class="source" data-w="${width}">${rows.join("")}</pre>
  </div>`;
}

/** The slice's own panel: everything the PR changed for this one purpose. */
function renderSlicePanel(
  slice: SliceInput,
  rank: number,
  index: FileIndex,
): string {
  const symbols = (slice.graph?.nodes ?? []).map((n) => ({
    name: n.name.split(".").pop() ?? n.name,
    nodeId: n.id,
  }));

  // Group by file, keeping the order the slice listed them in, so the most
  // important file of the slice still leads.
  const byFile = new Map<string, SliceFragmentInput[]>();
  for (const fragment of slice.fragments) {
    const group = byFile.get(fragment.file);
    if (group) group.push(fragment);
    else byFile.set(fragment.file, [fragment]);
  }
  const lines = slice.fragments.reduce((n, f) => n + f.lines.length, 0);
  const files = new Set(slice.fragments.map((f) => f.file));

  return `<article class="panel slice-panel" data-node="__slice__">
    <h3><span class="rank">${rank}</span> ${esc(slice.title)}</h3>
    <p class="slice-summary">${esc(slice.summary)}</p>
    <p class="slice-rationale">${esc(slice.rationale)}</p>
    <div class="slice-badges">
      <span class="badge">${slice.fragments.length} fragment${slice.fragments.length === 1 ? "" : "s"}</span>
      <span class="badge">${lines} lines</span>
      <span class="badge">${files.size} file${files.size === 1 ? "" : "s"}</span>
      ${slice.target ? `<span class="badge target">target ${esc(slice.target.name)}</span>` : ""}
      ${slice.graph ? "" : '<span class="badge">no call graph</span>'}
    </div>
    ${
      slice.graph
        ? '<p class="hint">tap a highlighted symbol to walk into its call graph</p>'
        : ""
    }
    ${[...byFile].map(([file, group]) => renderFileBlock(file, group, index.get(`after:${file}`), symbols)).join("")}
  </article>`;
}

const SLICE_CSS = `
  body.slice-explorer { max-width: none; padding: 0.8rem 1rem 0; }
  .stage { position: relative; overflow: hidden; height: calc(100vh - 96px); }
  .deck {
    display: flex; flex-direction: column; height: 100%;
    transform: translateY(calc(var(--slice, 0) * -100%));
    transition: transform 0.5s cubic-bezier(0.32, 0.72, 0, 1);
  }
  .deck.no-anim { transition: none; }
  .slice-view { flex: none; height: 100%; }
  .slice-view .viewport { height: 100%; }

  .vrail {
    position: absolute; left: 50%; transform: translateX(-50%); z-index: 3;
    display: none; align-items: center; gap: 0.5rem; max-width: 60%;
    border: 1px solid rgba(128,128,128,0.35); border-radius: 999px;
    background: Canvas; color: var(--accent); cursor: pointer;
    font: 600 0.75rem ui-sans-serif, system-ui, sans-serif;
    padding: 0.2rem 0.9rem; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis;
  }
  .vrail:hover { background: var(--callsite-bg); }
  .vrail-up { top: 4px; }
  .vrail-down { bottom: 4px; }
  .stage.can-up .vrail-up { display: flex; }
  .stage.can-down .vrail-down { display: flex; }

  .slice-panel > h3 { display: flex; align-items: baseline; gap: 0.5rem; margin: 0 0 0.4rem; font-size: 1rem; }
  .rank { font-size: 1.5rem; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; }
  .slice-summary { margin: 0 0 0.4rem; font-size: 0.88rem; }
  .slice-rationale { margin: 0 0 0.5rem; padding-left: 0.7rem; font-size: 0.82rem;
                     border-left: 2px solid rgba(128,128,128,0.3); color: var(--tok-com); }
  .slice-badges { display: flex; gap: 0.35rem; flex-wrap: wrap; margin-bottom: 0.6rem; }
  .badge.target { background: var(--callsite-bg); color: var(--accent); }
  .hint { margin: 0 0 0.8rem; font-size: 0.75rem; color: var(--tok-com); }
  .file-block { margin: 0 0 1.2rem; }
  .file-head { font-family: ui-monospace, Menlo, monospace; font-size: 0.78rem;
               color: var(--accent); margin-bottom: 0.25rem; }
  .frag-id { color: var(--accent); }
  /* The fragment's marker, sitting inline where its lines begin — the file
     block stays one continuous listing rather than a stack of boxes. Quiet
     enough to be a boundary rather than a heading. */
  .frag-note { border-top: 1px solid rgba(9,105,218,0.18); font-size: 0.7rem;
               opacity: 0.65; padding: 0.1rem 0; }

  .progress { display: flex; align-items: center; gap: 0.6rem; font-size: 0.78rem;
              color: var(--tok-com); margin: 0.3rem 0 0.5rem; }
  .pips { display: flex; gap: 3px; }
  .pip { width: 22px; height: 4px; border-radius: 2px; background: rgba(128,128,128,0.3);
         cursor: pointer; border: none; padding: 0; }
  .pip.on { background: var(--accent); }
`;

/**
 * The vertical axis: slices stacked, one filling the stage at a time.
 * Scrolling inside a slice behaves normally until it runs out of content;
 * pushing past the end carries you to the next slice, and past the top to
 * the previous one.
 */
const DECK_JS = `
(function () {
  var stage = document.querySelector(".stage");
  var deck = document.querySelector(".deck");
  var views = Array.prototype.slice.call(deck.children);
  var railUp = document.querySelector(".vrail-up");
  var railDown = document.querySelector(".vrail-down");
  var pips = Array.prototype.slice.call(document.querySelectorAll(".pip"));
  var label = document.querySelector(".progress-label");
  var TITLES = JSON.parse(document.getElementById("slice-titles").textContent);
  var current = 0, locked = false, overscroll = 0, overscrollDown = true, lastWheel = 0;
  /* How much overscroll past an edge commits to the next slice. One firm
     trackpad flick clears this; a coasting scroll that merely lands on the
     boundary does not. */
  var THRESHOLD = 180;

  function scrollables(i) {
    return Array.prototype.slice.call(views[i].querySelectorAll(".panel"));
  }
  function update() {
    deck.style.setProperty("--slice", String(current));
    stage.classList.toggle("can-up", current > 0);
    stage.classList.toggle("can-down", current < views.length - 1);
    if (current > 0) railUp.textContent = "\\u25b2 " + TITLES[current - 1];
    if (current < views.length - 1) railDown.textContent = TITLES[current + 1] + " \\u25bc";
    for (var i = 0; i < pips.length; i++) pips[i].classList.toggle("on", i === current);
    if (label) label.textContent = (current + 1) + " / " + views.length;
  }
  /* Land where the reader was heading: entering from above starts at the top
     of the new slice, entering from below starts at its bottom, so the
     motion reads as one continuous column. */
  function go(next, from) {
    if (next < 0 || next >= views.length || next === current) return;
    locked = true;
    overscroll = 0;
    current = next;
    update();
    var panels = scrollables(current);
    for (var i = 0; i < panels.length; i++) {
      panels[i].scrollTop = from === "below" ? panels[i].scrollHeight : 0;
    }
    setTimeout(function () { locked = false; }, 520);
  }
  function atTop(el) { return !el || el.scrollTop <= 1; }
  function atBottom(el) {
    return !el || el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
  }

  stage.addEventListener("wheel", function (e) {
    if (locked) { e.preventDefault(); return; }
    var pane = e.target.closest(".panel");
    var down = e.deltaY > 0;
    var edge = down ? atBottom(pane) : atTop(pane);
    if (!edge) { overscroll = 0; return; }
    var last = down ? current >= views.length - 1 : current <= 0;
    if (last) { overscroll = 0; return; }
    e.preventDefault();
    /* A pane shorter than the viewport is at its top and its bottom at once,
       so the tally has to be per-direction or an up-scroll would bank credit
       toward advancing downward. */
    if (down !== overscrollDown) { overscroll = 0; overscrollDown = down; }
    /* Forget a stale tally: three gentle nudges minutes apart should not add
       up to a slice change the reader never asked for. */
    var now = Date.now();
    if (now - lastWheel > 400) overscroll = 0;
    lastWheel = now;
    overscroll += Math.abs(e.deltaY);
    if (overscroll >= THRESHOLD) go(current + (down ? 1 : -1), down ? "above" : "below");
  }, { passive: false });

  document.addEventListener("keydown", function (e) {
    if (e.key === "PageDown") { e.preventDefault(); go(current + 1, "above"); }
    else if (e.key === "PageUp") { e.preventDefault(); go(current - 1, "below"); }
  });
  railUp.addEventListener("click", function () { go(current - 1, "below"); });
  railDown.addEventListener("click", function () { go(current + 1, "above"); });
  for (var p = 0; p < pips.length; p++) {
    (function (i) {
      pips[i].addEventListener("click", function () { go(i, "above"); });
    })(p);
  }
  update();
})();
`;

/**
 * The two axes fused: slices stacked vertically in priority order, and each
 * slice's call graph walkable horizontally from the symbols in its diff.
 */
export function renderSliceExplorerHtml(input: SliceExplorerInput): string {
  // One file index for the whole page: the expander script reads a single
  // `#render-data` blob, and files shared between slices key identically.
  // The changed files come first so that a file a call graph also embedded
  // wins — those entries carry the symbol table the expanders use for
  // breadcrumbs.
  const index = buildFileIndex([
    ...input.files,
    ...input.slices.flatMap((s) => s.graph?.files ?? []),
  ]);

  const views = input.slices
    .map((slice, i) => {
      const graph = slice.graph;
      const panels = graph
        ? graph.nodes.map((n) => renderPanel(n, graph, index)).join("\n")
        : "";
      const names = Object.fromEntries(
        (graph?.nodes ?? []).map((n) => [n.id, n.name]),
      );
      // Entity-escaped rather than raw: the browser decodes the attribute
      // before JSON.parse sees it, so a name containing a quote or ampersand
      // survives intact.
      return `<section class="slice-view" data-slice="${i}" data-names="${esc(JSON.stringify(names))}">
        <div class="viewport">
          <button class="rail rail-left"></button>
          <button class="rail rail-right"></button>
          <div class="track">${renderSlicePanel(slice, i + 1, index)}</div>
        </div>
        <div class="panel-defs" hidden>${panels}</div>
      </section>`;
    })
    .join("\n");

  const pips = input.slices
    .map(
      (s, i) =>
        `<button class="pip" title="${esc(`${i + 1}. ${s.title}`)}"></button>`,
    )
    .join("");
  const titles = input.slices.map((s) => s.title);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`${input.repo}#${input.number} — slice explorer`)}</title>
<style>${CSS}${EXPLORER_CSS}${SLICE_CSS}</style>
</head>
<body class="slice-explorer">
<div class="progress">
  <a href="${esc(input.prUrl)}">${esc(input.repo)}#${input.number}</a>
  <span>${esc(input.prTitle)}</span>
  <span class="pips">${pips}</span>
  <span class="progress-label"></span>
  <span>· scroll past the end of a slice to reach the next</span>
</div>

<div class="stage">
  <button class="vrail vrail-up"></button>
  <button class="vrail vrail-down"></button>
  <div class="deck">${views}</div>
</div>

<script type="application/json" id="slice-titles">${JSON.stringify(titles).replaceAll("</", "<\\/")}</script>
<script type="application/json" id="render-data">${renderDataBlob(index)}</script>
<script>
${GAP_JS}
${EXPLORER_NAV_JS}
document.querySelectorAll(".slice-view").forEach(function (view) {
  initExplorer(view, JSON.parse(view.dataset.names));
});
${DECK_JS}
</script>
</body>
</html>
`;
}
