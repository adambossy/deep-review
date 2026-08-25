import {
  EXPLORER_CSS,
  EXPLORER_NAV_JS,
  renderDefinitionPanel,
  renderPanel,
} from "./explorer.js";
import { NavIndex, definitionPanelId } from "./navLinks.js";
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
import type { CallPathResult, EmbeddedFile, NavigationData } from "./types.js";

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
  /**
   * Precomputed symbol → definition links, when the build resolved them.
   * Without it only call-graph symbols are tappable.
   */
  nav?: NavigationData | undefined;
}

interface GraphSymbol {
  name: string;
  nodeId: string;
  /** Where this function is declared at head, when it exists there. */
  declFile: string | null;
  declLine: number | null;
}

type Symbols = GraphSymbol[];

/** `def name`, `class name`, `function name` — the word introduces, not calls. */
const DECLARES = /(?:^|[^A-Za-z0-9_$])(?:def|class|function|fn|func|struct|interface|type|enum)\s+$/;

/**
 * Occurrences of a graph symbol in one line of source, as tappable marks.
 *
 * A function's own declaration is deliberately not marked: its body is right
 * there on the page, so tapping it would slide in a panel for what the
 * reader is already looking at. The language service tells us where each
 * function is declared; the keyword check catches the rest, including
 * functions the walk reached only on the base side.
 */
function symbolMarks(
  content: string,
  symbols: Symbols,
  file: string,
  line: number | null,
): Mark[] {
  const marks: Mark[] = [];
  for (const symbol of symbols) {
    if (symbol.declFile === file && symbol.declLine === line) continue;
    let from = 0;
    for (;;) {
      const at = content.indexOf(symbol.name, from);
      if (at < 0) break;
      from = at + symbol.name.length;
      const before = content[at - 1] ?? " ";
      const after = content[from] ?? " ";
      // Whole-word only: `retry` must not light up inside `retryDelay`.
      if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) continue;
      if (DECLARES.test(content.slice(0, at))) continue;
      marks.push({
        start: at,
        end: from,
        cls: "csite",
        attrs: `data-target="${esc(symbol.nodeId)}" role="button" tabindex="0"`,
      });
    }
  }
  return marks.sort((a, b) => a.start - b.start);
}

/** Lines of the head-side file shown either side of a fragment. */
const FRAGMENT_CONTEXT = 5;

/**
 * The head-side line ranges a file block shows for its fragments: each
 * fragment padded with context, overlapping or touching pads merged. Shared
 * with the navigation resolver so it asks about exactly the lines that
 * render. A deletion-only fragment (empty head extent) still earns context
 * around the point it sits at.
 */
export function fileBlockRanges(
  fragments: readonly SliceFragmentInput[],
  lineCount: number,
): Array<[number, number]> {
  const ordered = [...fragments].sort(
    (a, b) => a.headStart - b.headStart || a.headEnd - b.headEnd,
  );
  const ranges: Array<[number, number]> = [];
  for (const fragment of ordered) {
    const from = Math.max(1, fragment.headStart - FRAGMENT_CONTEXT);
    const to = Math.min(lineCount, Math.max(fragment.headEnd, fragment.headStart - 1) + FRAGMENT_CONTEXT);
    if (to < from) continue;
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  return ranges;
}

/** The fragment's own diff rows: additions tinted, removals kept in place. */
function fragmentRows(
  fragment: SliceFragmentInput,
  width: number,
  symbols: Symbols,
  nav: NavIndex,
): string[] {
  const lang = languageOf(fragment.file);
  const contents = fragment.lines.map((l) => l.slice(1));
  const tokens = tokenizeLines(contents, lang);

  return fragment.lines.map((line, i) => {
    if (line.startsWith("\\")) {
      return lineRow("", width, esc(line));
    }
    // A removed line has no head-side number, so it can never be the
    // declaration site the head-side check compares against — and has no
    // navigation links either.
    const headLine = fragment.newLineNumbers[i] ?? null;
    const graphMarks = symbolMarks(contents[i]!, symbols, fragment.file, headLine);
    const marks =
      headLine === null ? graphMarks : [...graphMarks, ...nav.marksFor(fragment.file, headLine, graphMarks)];
    const html = renderLine(contents[i]!, tokens[i]!, marks);
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
 * Every fragment a slice has in one file, rendered as one continuous stretch
 * of that file: each fragment surrounded by real context, the runs between
 * them collapsed behind expanders. Reading a file's changes should not mean
 * reassembling them from separate boxes.
 *
 * Nothing is interleaved between the fragments — no ids, no summaries. The
 * tinting already says which lines changed, and anything else in the column
 * breaks the listing the reader is trying to follow.
 */
/** "packages/webhooks/src/retry.ts" → dimmed directory, bold basename, +/− stats. */
function fileHead(file: string, fragments: SliceFragmentInput[]): string {
  const cut = file.lastIndexOf("/") + 1;
  const adds = fragments.reduce(
    (n, f) => n + f.lines.filter((l) => l.startsWith("+")).length,
    0,
  );
  const dels = fragments.reduce(
    (n, f) => n + f.lines.filter((l) => l.startsWith("-")).length,
    0,
  );
  return `<div class="file-head"><code>${
    cut > 0 ? `<span class="dir">${esc(file.slice(0, cut))}</span>` : ""
  }<span class="name">${esc(file.slice(cut))}</span></code><span class="stat">${
    adds ? `<span class="plus">+${adds}</span>` : ""
  }${dels ? `<span class="minus">−${dels}</span>` : ""}</span></div>`;
}

function renderFileBlock(
  file: string,
  fragments: SliceFragmentInput[],
  entry: ReturnType<FileIndex["get"]>,
  symbols: Symbols,
  nav: NavIndex,
): string {
  // Without the file's text there is no context to show and nothing to
  // expand into, so each fragment stands alone.
  if (!entry) {
    const width = 4;
    const rows = fragments.flatMap((f) => [
      `<span class="line hunk-header">${esc(f.hunkHeader)}</span>`,
      ...fragmentRows(f, width, symbols, nav),
    ]);
    return `<div class="file-block">${fileHead(file, fragments)}<pre class="source" data-w="${width}">${rows.join("")}</pre></div>`;
  }

  const width = String(entry.lines.length).length;
  const ordered = [...fragments].sort(
    (a, b) => a.headStart - b.headStart || a.headEnd - b.headEnd,
  );
  const rows: string[] = [];

  const contextRow = (n: number): void => {
    const text = entry.lines[n - 1] ?? "";
    const graphMarks = symbolMarks(text, symbols, file, n);
    const marks = [...graphMarks, ...nav.marksFor(file, n, graphMarks)];
    const html = marks.length
      ? renderLine(text, entry.tokens[n - 1] ?? [], marks)
      : (entry.html[n - 1] ?? "");
    rows.push(lineRow(n, width, html));
  };

  // Walk the visible ranges; within each, a fragment's own rows stand in
  // for the head lines it covers (a deletion-only fragment covers none, so
  // its rows go in just before the line it sits at).
  let cursor = 0;
  let next = 0;
  for (const [from, to] of fileBlockRanges(ordered, entry.lines.length)) {
    if (from > cursor + 1) rows.push(gapRow(entry, cursor + 1, from - 1));
    let n = from;
    while (n <= to) {
      const fragment = ordered[next];
      if (fragment && fragment.headStart === n) {
        rows.push(...fragmentRows(fragment, width, symbols, nav));
        next++;
        n = Math.max(n, fragment.headEnd + 1);
        continue;
      }
      contextRow(n);
      n++;
    }
    cursor = to;
  }

  if (cursor < entry.lines.length) {
    rows.push(gapRow(entry, cursor + 1, entry.lines.length));
  }

  return `<div class="file-block">
    ${fileHead(file, fragments)}
    <pre class="source" data-w="${width}">${rows.join("")}</pre>
  </div>`;
}

/** The slice's own panel: everything the PR changed for this one purpose. */
function renderSlicePanel(
  slice: SliceInput,
  rank: number,
  total: number,
  index: FileIndex,
  nav: NavIndex,
): string {
  const symbols: Symbols = (slice.graph?.nodes ?? []).map((n) => ({
    name: n.name.split(".").pop() ?? n.name,
    nodeId: n.id,
    // nameLine is given in the node's preferred revision, so it only locates
    // a head-side declaration when the function exists after the PR.
    declFile: n.after ? n.after.file : null,
    declLine: n.after ? n.nameLine : null,
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
    <span class="eyebrow">Slice ${rank} of ${total}</span>
    <h3 class="slice-title">${esc(slice.title)}</h3>
    <p class="slice-summary">${esc(slice.summary)}</p>
    <p class="slice-rationale">${esc(slice.rationale)}</p>
    <div class="slice-badges">
      <span class="badge">${slice.fragments.length} fragment${slice.fragments.length === 1 ? "" : "s"}</span>
      <span class="badge">${lines} lines</span>
      <span class="badge">${files.size} file${files.size === 1 ? "" : "s"}</span>
      ${slice.target ? `<span class="badge target">→ ${esc(slice.target.name)}</span>` : ""}
      ${slice.graph ? "" : '<span class="badge">no call graph</span>'}
      ${
        slice.graph
          ? '<span class="hint">tap a highlighted symbol to walk into its call graph</span>'
          : ""
      }
    </div>
    ${[...byFile].map(([file, group]) => renderFileBlock(file, group, index.get(`after:${file}`), symbols, nav)).join("")}
  </article>`;
}

const SLICE_CSS = `
  body.slice-explorer {
    max-width: none; margin: 0; padding: 0;
    display: grid; grid-template-columns: 240px 1fr;
  }
  .main { padding: 0.8rem 1rem; min-width: 0; }
  .stage { position: relative; overflow: hidden; height: calc(100vh - 1.6rem); }
  .deck {
    display: flex; flex-direction: column; height: 100%;
    transform: translateY(calc(var(--slice, 0) * -100%));
    transition: transform 0.5s cubic-bezier(0.32, 0.72, 0, 1);
  }
  .deck.no-anim { transition: none; }
  .slice-view { flex: none; height: 100%; }
  .slice-view .viewport { height: 100%; }

  .side {
    box-sizing: border-box; height: 100vh; position: sticky; top: 0;
    border-right: 1px solid var(--line-c); padding: 1.1rem 0.9rem;
    display: flex; flex-direction: column; gap: 1.2rem;
  }
  .side .pr { font-family: var(--mono); font-size: 0.72rem; color: var(--ink-soft); text-decoration: none; }
  .side .pr:hover { color: var(--accent); }
  .side .pr-title { font-size: 0.8rem; font-weight: 600; margin-top: 0.25rem; line-height: 1.35; }
  .side-label { font-size: 0.62rem; font-weight: 600; letter-spacing: 0.1em;
                text-transform: uppercase; color: var(--ink-faint); margin-bottom: 0.4rem; }
  .slice-nav { display: flex; flex-direction: column; gap: 2px; }
  .slice-link {
    display: flex; gap: 0.55rem; align-items: baseline; text-align: left;
    padding: 0.42rem 0.55rem; border-radius: 6px; border: none;
    background: none; color: var(--ink-soft); font: inherit; font-size: 0.78rem;
    cursor: pointer; line-height: 1.3;
  }
  .slice-link:hover { background: var(--panel-2); color: var(--ink); }
  .slice-link.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  .slice-link .n { font-variant-numeric: tabular-nums; font-size: 0.68rem; opacity: 0.7; }
  .side .foot { margin-top: auto; font-size: 0.7rem; color: var(--ink-faint); }
  .progress-label { font-variant-numeric: tabular-nums; }

  .history-toggle {
    display: flex; align-items: center; justify-content: space-between; width: 100%;
    background: none; border: none; padding: 0; margin-bottom: 0.4rem; cursor: pointer;
    color: inherit; font: inherit;
  }
  .history-toggle .chev {
    color: var(--ink-faint); font-size: 0.65rem; transition: transform 0.2s ease;
  }
  .history-block.collapsed .chev { transform: rotate(-90deg); }
  .history-block.collapsed .history-body { display: none; }
  .history-panel { display: flex; flex-direction: column; gap: 2px; }
  .history-panel[hidden] { display: none; }
  .history-entry {
    display: flex; gap: 0.5rem; align-items: baseline; text-align: left; width: 100%;
    padding: 0.32rem 0.55rem; border-radius: 6px; border: none;
    background: none; color: var(--ink-soft); font: inherit; font-size: 0.74rem;
    cursor: pointer; line-height: 1.3; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .history-entry:hover { background: var(--panel-2); color: var(--ink); }
  .history-entry.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  .history-entry .n { font-variant-numeric: tabular-nums; font-size: 0.65rem; opacity: 0.7; }

  .vrail {
    position: absolute; left: 50%; transform: translateX(-50%); z-index: 3;
    display: none; align-items: center; gap: 0.5rem; max-width: 60%;
    border: 1px solid var(--line-c); border-radius: 999px;
    background: var(--panel); color: var(--accent); cursor: pointer;
    font: 600 0.75rem ui-sans-serif, system-ui, sans-serif;
    padding: 0.2rem 0.9rem; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis;
  }
  .vrail:hover { background: var(--accent-soft); border-color: var(--accent); }
  .vrail-up { top: 4px; }
  .vrail-down { bottom: 4px; }
  .stage.can-up .vrail-up { display: flex; }
  .stage.can-down .vrail-down { display: flex; }

  .eyebrow {
    display: inline-flex; align-items: center; gap: 0.4rem;
    font-size: 0.65rem; font-weight: 600; letter-spacing: 0.09em;
    text-transform: uppercase; color: var(--accent); margin-bottom: 0.4rem;
  }
  .eyebrow::before { content: ""; width: 16px; height: 1px; background: var(--accent); }
  .slice-panel > h3.slice-title {
    font-size: 1.35rem; font-weight: 650; letter-spacing: -0.015em; margin: 0 0 0.5rem;
  }
  .slice-summary { margin: 0 0 0.55rem; font-size: 0.88rem; color: var(--ink-soft); max-width: 44rem; }
  .slice-rationale { margin: 0 0 0.9rem; font-size: 0.8rem; color: var(--ink-faint); max-width: 44rem; }
  .slice-badges { display: flex; gap: 0.4rem; flex-wrap: wrap; align-items: center; margin-bottom: 1.1rem; }
  .badge.target { background: var(--accent-soft); color: var(--accent); border-color: transparent;
                  font-family: var(--mono); }
  .hint { font-size: 0.7rem; color: var(--ink-faint); margin-left: 0.3rem; }

  .file-block {
    border: 1px solid var(--line-c); border-radius: 8px; overflow: hidden;
    margin: 0 0 1.1rem; background: var(--panel);
  }
  .file-head {
    display: flex; align-items: center; gap: 0.6rem;
    padding: 0.5rem 0.9rem; background: var(--panel-2);
    border-bottom: 1px solid var(--line-c);
    font-family: var(--mono); font-size: 0.74rem;
  }
  .file-head .dir { color: var(--ink-faint); }
  .file-head .name { color: var(--ink); font-weight: 600; }
  .file-head .stat { margin-left: auto; font-size: 0.68rem; font-variant-numeric: tabular-nums; }
  .file-head .plus { color: var(--add-edge); }
  .file-head .minus { color: var(--del-edge); margin-left: 0.4rem; }
  .file-block pre.source { border: none; border-radius: 0; margin: 0; }
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
  var pips = Array.prototype.slice.call(document.querySelectorAll(".slice-link"));
  var label = document.querySelector(".progress-label");
  var historyPanels = Array.prototype.slice.call(document.querySelectorAll(".history-panel"));
  var TITLES = JSON.parse(document.getElementById("slice-titles").textContent);
  var current = 0, locked = false, overscroll = 0, overscrollDown = true, lastWheel = 0;
  /* How much overscroll past an edge commits to the next slice. One firm
     trackpad flick clears this; a coasting scroll that merely lands on the
     boundary does not. */
  var THRESHOLD = 550;

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
    for (var h = 0; h < historyPanels.length; h++) {
      historyPanels[h].hidden = Number(historyPanels[h].dataset.slice) !== current;
    }
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
 * A collapsible breadcrumb trail per slice, in the sidebar. Every walk into
 * a caller or callee appends a step; clicking any earlier step restores the
 * track to exactly that arrangement and drops everything after it, the way
 * browser history does. Each slice keeps its own trail — switching slices
 * (the DECK_JS vertical axis) just swaps which trail is visible.
 */
const HISTORY_JS = `
(function () {
  var views = Array.prototype.slice.call(document.querySelectorAll(".slice-view"));
  var TITLES = JSON.parse(document.getElementById("slice-titles").textContent);
  var block = document.querySelector(".history-block");
  var trails = {};

  function esc1(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }
  function sameIds(a, b) {
    if (a.length !== b.length) return false;
    for (var m = 0; m < a.length; m++) if (a[m] !== b[m]) return false;
    return true;
  }
  function render(sliceIndex) {
    var panel = document.querySelector('.history-panel[data-slice="' + sliceIndex + '"]');
    if (!panel) return;
    var trail = trails[sliceIndex] || [];
    panel.innerHTML = trail.map(function (step, i) {
      var on = i === trail.length - 1 ? " on" : "";
      return '<button class="history-entry' + on + '" data-idx="' + i + '">' +
        '<span class="n">' + (i + 1) + '</span> ' + esc1(step.label) + '</button>';
    }).join("");
  }

  views.forEach(function (view) {
    var sliceIndex = Number(view.dataset.slice);
    var names = JSON.parse(view.dataset.names);
    trails[sliceIndex] = [{ id: "__slice__", ids: ["__slice__"], pos: 0, label: TITLES[sliceIndex] }];
    render(sliceIndex);
    initExplorer(view, names, function (step) {
      var trail = trails[sliceIndex];
      // Landing on a state the trail already recorded — same track
      // composition AND the same slot in view, whether reached by tapping
      // a reference back to it or just paging the rail — is not a new
      // step. Only the id matching isn't enough: a fresh path can land on
      // a node the trail visited earlier in a completely different
      // arrangement, and that deserves its own entry, not a merge into the
      // old one.
      var foundIdx = -1;
      for (var k = trail.length - 1; k >= 0; k--) {
        if (trail[k].pos === step.pos && sameIds(trail[k].ids, step.ids)) { foundIdx = k; break; }
      }
      trails[sliceIndex] = foundIdx >= 0
        ? trail.slice(0, foundIdx + 1)
        : trail.concat([{ id: step.id, ids: step.ids, pos: step.pos, label: names[step.id] || (window.DEFNAMES || {})[step.id] || step.id }]);
      render(sliceIndex);
    });
  });

  document.addEventListener("click", function (e) {
    var entry = e.target.closest(".history-entry");
    if (entry) {
      var panel = entry.closest(".history-panel");
      var sliceIndex = Number(panel.dataset.slice);
      var idx = Number(entry.dataset.idx);
      var step = trails[sliceIndex][idx];
      views[sliceIndex].__restore(step.ids, step.pos);
      trails[sliceIndex] = trails[sliceIndex].slice(0, idx + 1);
      render(sliceIndex);
      return;
    }
    if (e.target.closest(".history-toggle")) {
      block.classList.toggle("collapsed");
      try {
        localStorage.setItem("history-collapsed", block.classList.contains("collapsed") ? "1" : "0");
      } catch (err) { /* localStorage unavailable (e.g. file:// in some browsers) */ }
    }
  });

  try {
    if (localStorage.getItem("history-collapsed") === "1") block.classList.add("collapsed");
  } catch (err) { /* localStorage unavailable */ }
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
  const nav = new NavIndex(input.nav);

  const views = input.slices
    .map((slice, i) => {
      const graph = slice.graph;
      const panels = graph
        ? graph.nodes.map((n) => renderPanel(n, graph, index, nav)).join("\n")
        : "";
      const names = Object.fromEntries(
        (graph?.nodes ?? []).map((n) => [n.id, n.name]),
      );
      // The slice panel sits at the head of the track, so the back rail can
      // point at it; give it the slice's own title rather than "back".
      names["__slice__"] = slice.title;
      // Entity-escaped rather than raw: the browser decodes the attribute
      // before JSON.parse sees it, so a name containing a quote or ampersand
      // survives intact.
      return `<section class="slice-view" data-slice="${i}" data-names="${esc(JSON.stringify(names))}">
        <div class="viewport">
          <button class="rail rail-left"></button>
          <button class="rail rail-right"></button>
          <div class="track">${renderSlicePanel(slice, i + 1, input.slices.length, index, nav)}</div>
        </div>
        <div class="panel-defs" hidden>${panels}</div>
      </section>`;
    })
    .join("\n");

  const sliceLinks = input.slices
    .map(
      (s, i) =>
        `<button class="slice-link" title="${esc(`${i + 1}. ${s.title}`)}"><span class="n">${i + 1}</span> ${esc(s.title)}</button>`,
    )
    .join("");
  const titles = input.slices.map((s) => s.title);

  // Definition panels are shared across slices — emitted once, page-wide.
  const definitionPanels = nav
    .panelsNeeded()
    .map((def) => renderDefinitionPanel(def, index, nav))
    .join("\n");
  const defNames = Object.fromEntries(
    nav.panelsNeeded().map((def) => [definitionPanelId(def), def.name]),
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`${input.repo}#${input.number} — slice explorer`)}</title>
<style>${CSS}${EXPLORER_CSS}${SLICE_CSS}</style>
</head>
<body class="slice-explorer">
<aside class="side">
  <div>
    <a class="pr" href="${esc(input.prUrl)}">${esc(input.repo)}#${input.number}</a>
    <div class="pr-title">${esc(input.prTitle)}</div>
  </div>
  <nav>
    <div class="side-label">Slices · <span class="progress-label"></span></div>
    <div class="slice-nav">${sliceLinks}</div>
  </nav>
  <div class="history-block">
    <button class="history-toggle" type="button">
      <span class="side-label">History</span>
      <span class="chev">▾</span>
    </button>
    <div class="history-body">
      ${input.slices.map((_, i) => `<div class="history-panel" data-slice="${i}"${i === 0 ? "" : " hidden"}></div>`).join("")}
    </div>
  </div>
  <div class="foot">scroll past the end of a slice to reach the next</div>
</aside>

<div class="main">
<div class="stage">
  <button class="vrail vrail-up"></button>
  <button class="vrail vrail-down"></button>
  <div class="deck">${views}</div>
</div>
</div>

<div id="shared-defs" class="panel-defs" hidden>${definitionPanels}</div>

<script type="application/json" id="slice-titles">${JSON.stringify(titles).replaceAll("</", "<\\/")}</script>
<script type="application/json" id="def-names">${JSON.stringify(defNames).replaceAll("</", "<\\/")}</script>
<script type="application/json" id="render-data">${renderDataBlob(index)}</script>
<script>
window.DEFNAMES = JSON.parse(document.getElementById("def-names").textContent);
${GAP_JS}
${EXPLORER_NAV_JS}
${HISTORY_JS}
${DECK_JS}
</script>
</body>
</html>
`;
}
