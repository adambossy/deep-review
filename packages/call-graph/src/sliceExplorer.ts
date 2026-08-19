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
import { buildFileIndex, CSS, GAP_JS, renderDataBlob } from "./html.js";
import type { CallPathResult } from "./types.js";

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

/** A fragment's diff lines, tinted, numbered, and symbol-marked. */
function renderFragment(
  fragment: SliceFragmentInput,
  symbols: { name: string; nodeId: string }[],
): string {
  const lang = languageOf(fragment.file);
  const contents = fragment.lines.map((l) => l.slice(1));
  const tokens = tokenizeLines(contents, lang);
  const width = Math.max(
    4,
    String(
      Math.max(...fragment.newLineNumbers.map((n) => n ?? 0), 1),
    ).length,
  );

  const rows = fragment.lines.map((line, i) => {
    if (line.startsWith("\\")) {
      return `<span class="line"><span class="lineno">${" ".repeat(width)}</span>${esc(line)}</span>`;
    }
    const cls = line.startsWith("+")
      ? " diff-add"
      : line.startsWith("-")
        ? " diff-del"
        : "";
    const no = line.startsWith("-")
      ? "−".padStart(width)
      : String(fragment.newLineNumbers[i] ?? "").padStart(width);
    const html = renderLine(
      contents[i]!,
      tokens[i]!,
      symbolMarks(contents[i]!, symbols),
    );
    return `<span class="line${cls}"><span class="lineno">${no}</span>${html}</span>`;
  });

  return `<div class="frag">
    <div class="frag-head"><code class="frag-id">${esc(fragment.id)}</code><span class="frag-file">${esc(fragment.file)}</span></div>
    <p class="frag-sum">${esc(fragment.summary)}</p>
    <span class="line hunk-header">${esc(fragment.hunkHeader)}</span>
    <pre class="source" data-w="${width}">${rows.join("")}</pre>
  </div>`;
}

/** The slice's own panel: everything the PR changed for this one purpose. */
function renderSlicePanel(slice: SliceInput, rank: number): string {
  const symbols = (slice.graph?.nodes ?? []).map((n) => ({
    name: n.name.split(".").pop() ?? n.name,
    nodeId: n.id,
  }));
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
    ${slice.fragments.map((f) => renderFragment(f, symbols)).join("")}
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
  .frag { margin: 0 0 1rem; }
  .frag-head { display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap; font-size: 0.72rem; }
  .frag-id { color: var(--accent); }
  .frag-file { color: var(--tok-com); }
  .frag-sum { margin: 0.15rem 0 0.3rem; font-size: 0.8rem; }
  .frag .hunk-header { display: block; font-family: ui-monospace, Menlo, monospace;
                       font-size: 0.75rem; color: var(--tok-com); }

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
  const index = buildFileIndex(
    input.slices.flatMap((s) => s.graph?.files ?? []),
  );

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
          <div class="track">${renderSlicePanel(slice, i + 1)}</div>
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
