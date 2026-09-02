import { EXPLORER_CSS, EXPLORER_NAV_JS, renderPanel } from "./explorer.js";
import { renderCodePane } from "./codePane.js";
import { fragmentDiffRows } from "./diffView.js";
import { escapeHtml as esc, languageOf } from "./highlight.js";
import { renderMarkdown } from "./markdown.js";
import { buildFileIndex, CSS, GAP_JS, renderDataBlob, SCOPE_JS, WRAP_JS, type FileIndex } from "./html.js";

export { fileBlockRanges } from "./diffView.js";
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
  /**
   * The PR description as authored, Markdown and all. Shown on its own tab:
   * what the author says the change is for, next to what it actually does.
   * Absent or empty renders the tab with a note that the PR has no
   * description, rather than hiding it — its absence is itself worth seeing.
   */
  prDescription?: string | undefined;
  /** The PR's author, shown alongside the description. */
  prAuthor?: string | undefined;
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
   * Debug builds: every marked symbol says why it is marked, and every
   * identifier what the navigation server said about it, in a hint shown
   * while Shift is held.
   */
  debugMarks?: boolean | undefined;
}

/**
 * One file index for the whole page: the expander script reads a single
 * `#render-data` blob, and files shared between slices key identically.
 * The changed files come first so that a file a call graph also embedded
 * wins — those entries carry the symbol table the expanders use for
 * breadcrumbs. The navigation server builds the same index, so a panel it
 * renders later matches the page.
 */
export function explorerFileIndex(input: SliceExplorerInput): FileIndex {
  return buildFileIndex([...input.files, ...input.slices.flatMap((s) => s.graph?.files ?? [])]);
}

/** The slice's own panel: everything the PR changed for this one purpose. */
function renderSlicePanel(
  slice: SliceInput,
  rank: number,
  total: number,
  index: FileIndex,
  debug: boolean,
): string {
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
      <span class="hint">tap a symbol to open its definition · ⌘-click for its callers</span>
    </div>
    ${[...byFile]
      .map(([file, group]) => {
        const entry = index.get(`after:${file}`);
        return renderCodePane({
          file,
          entry,
          rows: fragmentDiffRows(entry?.lines, group),
          lang: languageOf(file),
          navigable: { side: "after" },
          debug,
        });
      })
      .join("")}
  </article>`;
}

const SLICE_CSS = `
  body.slice-explorer {
    max-width: none; margin: 0; padding: 0;
    display: grid; grid-template-columns: 240px 1fr;
  }
  .main { padding: 0.8rem 1rem; min-width: 0; --tab-bar: 2.1rem; }
  .stage { position: relative; overflow: hidden; height: calc(100vh - 1.6rem - var(--tab-bar)); }
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

  .slice-panel .code-pane { margin: 0 0 1.1rem; }

  /* The two views of the PR: what it changed, and what its author says
     about it. The tab bar sits above both and is the only thing that
     switches between them. */
  .view-tabs { display: flex; gap: 0.3rem; align-items: center; height: var(--tab-bar); }
  .view-tab {
    appearance: none; border: none; border-radius: 999px; background: none;
    color: var(--ink-soft); font: 600 0.74rem ui-sans-serif, system-ui, sans-serif;
    padding: 0.22rem 0.75rem; cursor: pointer;
  }
  .view-tab:hover { background: var(--panel-2); color: var(--ink); }
  .view-tab[aria-selected="true"] { background: var(--accent-soft); color: var(--accent); }

  .doc-view {
    height: calc(100vh - 1.6rem - var(--tab-bar));
    overflow-y: auto; padding-right: 0.8rem;
  }
  .doc-view[hidden] { display: none; }
  .doc-title { font-size: 1.35rem; font-weight: 650; letter-spacing: -0.015em;
               margin: 0 0 0.4rem; max-width: 48rem; }
  .doc-meta { font-size: 0.74rem; color: var(--ink-faint); margin-bottom: 1.4rem; }
  .doc-meta a { color: var(--accent); text-decoration: none; font-family: var(--mono); }
  .doc-block { max-width: 48rem; margin-bottom: 1.8rem; }
  .doc-overview { margin: 0; font-size: 0.88rem; color: var(--ink-soft); line-height: 1.6; }
  .doc-empty { font-size: 0.85rem; color: var(--ink-faint); font-style: italic; }

  .md-h { margin: 1.3rem 0 0.5rem; font-weight: 650; letter-spacing: -0.01em; }
  .md-p { margin: 0 0 0.75rem; font-size: 0.88rem; line-height: 1.6; }
  .md-list { margin: 0 0 0.8rem; padding-left: 1.25rem; font-size: 0.88rem; line-height: 1.6; }
  .md-list .md-list { margin: 0.2rem 0; }
  /* A task item carries its own box, so the bullet would be a second marker. */
  .md-list li:has(> .md-task) { list-style: none; margin-left: -1rem; }
  .md-task { font-family: var(--mono); color: var(--ink-faint); }
  .md-task.done { color: var(--add-edge); }
  .md-quote { margin: 0 0 0.8rem; padding: 0.1rem 0 0.1rem 0.8rem;
              border-left: 2px solid var(--line-c); color: var(--ink-soft); }
  .md-rule { border: none; border-top: 1px solid var(--line-c); margin: 1.2rem 0; }
  .md-code {
    margin: 0 0 0.9rem; padding: 0.6rem 0.8rem; overflow-x: auto;
    border: 1px solid var(--line-c); border-radius: 6px; background: var(--panel-2);
    font-family: var(--mono); font-size: 0.76rem; line-height: 1.5;
  }
  .md-inline-code { font-family: var(--mono); font-size: 0.82em; padding: 0.08em 0.32em;
                    border-radius: 4px; background: var(--panel-2); }
  .md-a { color: var(--accent); }
  .md-img { max-width: 100%; border: 1px solid var(--line-c); border-radius: 6px; }
  .doc-block > :last-child { margin-bottom: 0; }
`;

/**
 * The description tab: the PR as its author wrote it, plus the slicing
 * model's own one-paragraph read of it. Neither is code — the point of the
 * tab is to be able to check the claim against the diff without leaving the
 * page for GitHub.
 */
function renderDescriptionView(input: SliceExplorerInput): string {
  const description = (input.prDescription ?? "").trim();
  return `<section class="doc-view" data-view="description" hidden>
    <span class="eyebrow">Pull request</span>
    <h3 class="doc-title">${esc(input.prTitle)}</h3>
    <div class="doc-meta">
      <a href="${esc(input.prUrl)}">${esc(input.repo)}#${input.number}</a>
      ${input.prAuthor ? ` · opened by ${esc(input.prAuthor)}` : ""}
    </div>
    <div class="doc-block">
      <div class="side-label">Description</div>
      ${description ? renderMarkdown(description, { baseUrl: input.prUrl }) : `<p class="doc-empty">This PR has no description.</p>`}
    </div>
    <div class="doc-block">
      <div class="side-label">Overview · what the slicer read</div>
      <p class="doc-overview">${esc(input.overview)}</p>
    </div>
  </section>`;
}

/**
 * Switching views, and nothing else: each view keeps its own scroll state
 * and the slice deck keeps its position, so coming back to the code lands
 * where the reader left it.
 */
const TABS_JS = `
(function () {
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".view-tab"));
  var views = {};
  Array.prototype.forEach.call(document.querySelectorAll("[data-view]"), function (el) {
    if (!el.classList.contains("view-tab")) views[el.dataset.view] = el;
  });

  function show(name) {
    tabs.forEach(function (t) {
      t.setAttribute("aria-selected", String(t.dataset.view === name));
    });
    Object.keys(views).forEach(function (key) { views[key].hidden = key !== name; });
  }

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () { show(tab.dataset.view); });
  });
})();
`;

/**
 * The vertical axis: slices stacked, one filling the stage at a time.
 * Scrolling inside a slice behaves normally until it runs out of content;
 * pushing past the end carries you to the next slice, and past the top to
 * the previous one.
 */
/**
 * Debug builds: hold Shift and hover a span to see why it is marked, in a
 * label over it, colour-coded by kind; an identifier says what the
 * navigation server answered when it was clicked, or that it has not been
 * asked yet. Only the hovered span speaks — labelling every span at once
 * buries a dense line. Nothing shows until Shift is down.
 */
const DEBUG_MARKS_CSS = `
  body.debug-marks [data-why]:hover { position: relative; outline: 1px dashed var(--dbg, var(--ink-faint)); outline-offset: 1px; }
  body.debug-marks [data-why]:hover::after {
    content: attr(data-why); position: absolute; left: 0; bottom: calc(100% + 3px); z-index: 7;
    font: 500 0.72rem/1.35 ui-sans-serif, system-ui, sans-serif; letter-spacing: 0;
    color: var(--ink); background: var(--panel); border: 1px solid var(--dbg, var(--line-c));
    border-radius: 4px; padding: 2px 6px; width: max-content; max-width: 44ch; white-space: normal; pointer-events: none;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
  }
  body.debug-marks .id[data-why] { --dbg: var(--ink-faint); }
  body.debug-marks .csite[data-why] { --dbg: var(--accent); }
  body.debug-marks .sym[data-why] { --dbg: var(--add-edge); }
  body.debug-marks .self-sym[data-why] { --dbg: #a855f7; }
  #debug-legend {
    position: fixed; right: 12px; bottom: 12px; z-index: 50; display: none;
    flex-direction: column; gap: 3px; padding: 0.5rem 0.7rem;
    border: 1px solid var(--line-c); border-radius: 8px; background: var(--panel);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    font: 0.68rem/1.4 ui-sans-serif, system-ui, sans-serif; color: var(--ink-soft);
  }
  body.debug-marks #debug-legend { display: flex; }
  #debug-legend b { color: var(--ink); }
  #debug-legend .sw { display: inline-block; width: 0.7em; height: 0.7em; border: 1px dashed; margin-right: 0.4em; vertical-align: -1px; }
`;

const DEBUG_MARKS_LEGEND = `<div id="debug-legend">
  <b>Hold Shift and hover a symbol to see why it is marked</b>
  <span><i class="sw" style="border-color: var(--accent)"></i><b>csite</b> — a call-graph edge, marked when the page was built</span>
  <span><i class="sw" style="border-color: var(--add-edge)"></i><b>sym</b> — the navigation server resolved it when clicked</span>
  <span><i class="sw" style="border-color: #a855f7"></i><b>decl</b> — a declaration the page knows (lights up in place)</span>
  <span><i class="sw" style="border-color: var(--ink-faint)"></i><b>id</b> — not asked yet, or unresolved with the reason</span>
</div>`;

const DEBUG_MARKS_JS = `
window.DEBUG_MARKS = true;
(function () {
  function set(on) { document.body.classList.toggle("debug-marks", on); }
  document.addEventListener("keydown", function (e) { if (e.key === "Shift") set(true); });
  document.addEventListener("keyup", function (e) { if (e.key === "Shift") set(false); });
  window.addEventListener("blur", function () { set(false); });
})();
`;

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
    /* Paging belongs to the slice deck; on the description tab the keys
       should scroll the prose the reader is actually looking at. */
    if (stage.hidden) return;
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
  const index = explorerFileIndex(input);
  const debug = input.debugMarks ?? false;

  const views = input.slices
    .map((slice, i) => {
      const graph = slice.graph;
      const panels = graph
        ? graph.nodes.map((n) => renderPanel(n, graph, index, { debug })).join("\n")
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
          <div class="track">${renderSlicePanel(slice, i + 1, input.slices.length, index, debug)}</div>
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

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`${input.repo}#${input.number} — slice explorer`)}</title>
<style>${CSS}${EXPLORER_CSS}${SLICE_CSS}${input.debugMarks ? DEBUG_MARKS_CSS : ""}</style>
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
<div class="view-tabs" role="tablist">
  <button class="view-tab" role="tab" data-view="slices" aria-selected="true">Slices</button>
  <button class="view-tab" role="tab" data-view="description" aria-selected="false">Description</button>
</div>
<div class="stage" data-view="slices">
  <button class="vrail vrail-up"></button>
  <button class="vrail vrail-down"></button>
  <div class="deck">${views}</div>
</div>
${renderDescriptionView(input)}
</div>

${input.debugMarks ? DEBUG_MARKS_LEGEND : ""}
<!-- Definition panels arrive here from the navigation server as they are first opened. -->
<div id="shared-defs" class="panel-defs" hidden></div>

<script type="application/json" id="slice-titles">${JSON.stringify(titles).replaceAll("</", "<\\/")}</script>
<script type="application/json" id="render-data">${renderDataBlob(index)}</script>
<script>
${GAP_JS}
${WRAP_JS}
${SCOPE_JS}
${EXPLORER_NAV_JS}
${HISTORY_JS}
${DECK_JS}
${TABS_JS}
${input.debugMarks ? DEBUG_MARKS_JS : ""}
</script>
</body>
</html>
`;
}
