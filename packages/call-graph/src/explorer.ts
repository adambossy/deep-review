import { renderCodePane } from "./codePane.js";
import { fileDiffRows, markIntraLine, segmentRows, type DiffRow } from "./diffView.js";
import { escapeHtml as esc, languageOf, type Mark } from "./highlight.js";
import {
  buildFileIndex,
  dataScripts,
  GAP_JS,
  pageHead,
  pageHeader,
  presenceBadge,
  SCOPE_JS,
  WRAP_JS,
  type Decorations,
  type FileEntry,
  type FileIndex,
} from "./html.js";
import type {
  CallPathResult,
  CallSite,
  DefinitionTarget,
  DiffHunk,
  PathNode,
  SourceSegment,
} from "./types.js";

function sitesFor(side: "before" | "after", edge: { before: CallSite[]; after: CallSite[] }): CallSite[] {
  return side === "after" ? edge.after : edge.before;
}

/** Lines of surrounding file context shown around a function, like `diff -U10`. */
const PANEL_CONTEXT = 10;

/**
 * The head-side lines a panel shows for a declaration spanning
 * `startLine..endLine` in a file of `lineCount` lines: the declaration
 * padded with context on both sides.
 */
export function panelRange(
  span: { startLine: number; endLine: number },
  lineCount: number,
): [number, number] {
  return [Math.max(1, span.startLine - PANEL_CONTEXT), Math.min(lineCount, span.endLine + PANEL_CONTEXT)];
}

/** Panel id of a definition: a graph node keeps its own; anything else is `def:<id>`. */
export function definitionPanelId(def: DefinitionTarget): string {
  return def.nodeId ?? `def:${def.id}`;
}

export interface PanelOptions {
  /** Debug builds: every mark says where it came from (`data-why`). */
  debug?: boolean | undefined;
}

export interface DefinitionPanelOptions extends PanelOptions {
  /**
   * The PR's hunks over this declaration, head-side. Taken from the whole
   * diff rather than from a slice's fragments: which slice claimed the
   * change says nothing about whether the declaration changed.
   */
  hunks?: DiffHunk[] | undefined;
}

/**
 * The diff rows a panel shows for a declaration: the whole file's changes
 * and the declaration itself, each with context, when the file is embedded;
 * otherwise the source segments we have, with the hunks applied.
 */
function panelRows(
  span: LineSpanWithSource,
  hunks: DiffHunk[],
  entry: FileEntry | undefined,
): DiffRow[] {
  const rows = entry
    ? fileDiffRows(entry.lines, hunks, { context: PANEL_CONTEXT, focus: span })
    : segmentRows(span.source, hunks);
  markIntraLine(rows);
  return rows;
}

interface LineSpanWithSource {
  startLine: number;
  endLine: number;
  source: SourceSegment[];
}

export function renderPanel(
  node: PathNode,
  result: CallPathResult,
  index: FileIndex,
  options: PanelOptions = {},
): string {
  const debug = options.debug ?? false;
  const side: "before" | "after" = node.after ? "after" : "before";
  const snapshot = (node.after ?? node.before)!;
  const entry = index.get(`${side}:${snapshot.file}`);

  // Hunks are in head coordinates; a before-only function shows plain source.
  const rows = panelRows(snapshot, side === "after" ? node.hunks : [], entry);

  // Overlays on the diff: each outgoing call tappable, the declared name
  // marked. The call marks come from the language service's own call
  // hierarchy, exact and free — and for a before-side panel, which the
  // navigation server (head checkout only) cannot answer about, they are
  // the only way to walk down.
  const decorations: Decorations = new Map();
  for (const edge of result.edges) {
    if (edge.from !== node.id) continue;
    for (const site of sitesFor(side, edge)) {
      if (site.startColumn === undefined || site.endColumn === undefined) continue;
      const existing = decorations.get(site.line) ?? {};
      const mark: Mark = {
        start: site.startColumn,
        end: site.endColumn,
        cls: "csite",
        attrs: `data-target="${esc(edge.to)}" role="button" tabindex="0"`,
        ...(debug ? { why: `csite · call-graph edge ${node.id} → ${edge.to}` } : {}),
      };
      decorations.set(site.line, { ...existing, marks: [...(existing.marks ?? []), mark] });
    }
  }

  // Mark the function's own name on its declaration line so the navigator
  // can tint it when this panel is opened from a click on that symbol. The
  // language service gives the exact position; fall back to a text search
  // across the span (the name may sit below a JSDoc block within it).
  const bareName = node.name.split(".").pop() ?? node.name;
  const lineTextAt = (n: number): string =>
    entry
      ? (entry.lines[n - 1] ?? "")
      : (snapshot.source
          .map((seg) => (n >= seg.startLine ? seg.lines[n - seg.startLine] : undefined))
          .find((l) => l !== undefined) ?? "");
  let namePos: { line: number; column: number } | null =
    lineTextAt(node.nameLine).startsWith(bareName, node.nameColumn)
      ? { line: node.nameLine, column: node.nameColumn }
      : null;
  const nameFromService = namePos !== null;
  for (let n = snapshot.startLine; !namePos && n <= snapshot.endLine; n++) {
    const column = lineTextAt(n).indexOf(bareName);
    if (column >= 0) namePos = { line: n, column };
  }
  if (namePos) {
    const existing = decorations.get(namePos.line) ?? {};
    decorations.set(namePos.line, {
      ...existing,
      marks: [
        ...(existing.marks ?? []),
        {
          start: namePos.column,
          end: namePos.column + bareName.length,
          cls: "self-sym",
          ...(debug
            ? { why: `decl · ${node.name}, graph node ${node.id} (${nameFromService ? "language service" : "text search"})` }
            : {}),
        },
      ],
    });
  }

  // Incoming edges become tappable "called by" rows, one per call site,
  // folded away by default: a widely used function has dozens, and the
  // code is what the panel is for.
  const nodeName = new Map(result.nodes.map((n) => [n.id, n.name]));
  const callerRows = result.edges
    .filter((edge) => edge.to === node.id)
    .flatMap((edge) => {
      const sites = sitesFor(side, edge).length ? sitesFor(side, edge) : sitesFor(side === "after" ? "before" : "after", edge);
      return sites.map(
        (site) =>
          `<button class="caller-row" data-target="${esc(edge.from)}">↖ <code class="fn-name">${esc(
            nodeName.get(edge.from) ?? edge.from,
          )}</code> <span class="loc">L${site.line}</span> <code>${esc(site.snippet)}</code></button>`,
      );
    });
  const calledBy = callerRows.length
    ? `<details class="fn called-by"><summary title="tap a row to walk up">called by (${callerRows.length})</summary><div class="caller-rows">${callerRows.join("")}</div></details>`
    : "";

  return `<article class="panel" data-node="${esc(node.id)}">
    <h3><code class="fn-name">${esc(node.name)}</code> ${presenceBadge(node)}</h3>
    <div class="side-loc"><code>${esc(snapshot.file)}:${snapshot.startLine}–${snapshot.endLine}</code> <span class="badge">${side}</span>${
      node.expanded ? "" : ' <span class="badge">boundary</span>'
    }</div>
    ${calledBy}
    ${renderCodePane({
      file: snapshot.file,
      entry,
      rows,
      lang: languageOf(snapshot.file),
      decorations,
      focus: snapshot,
      navigable: { side },
      debug,
    })}
  </article>`;
}

/**
 * A panel for a definition the call graph did not reach — a class, a
 * constant, an import, a local, or something in a dependency. Same card as
 * a function's, minus the called-by rows the call graph would supply. Its
 * diff comes from the PR instead, so the panel shades the same whichever
 * slice the reader opened it from. Rendered by the navigation server when a
 * reader first opens it.
 */
export function renderDefinitionPanel(
  def: DefinitionTarget,
  index: FileIndex,
  options: DefinitionPanelOptions = {},
): string {
  const debug = options.debug ?? false;
  // A window wins when present: the file is not on the page whole.
  const entry = def.external || def.source ? undefined : index.get(`after:${def.file}`);
  if (!entry && !def.source) return "";
  const rows = panelRows({ ...def, source: def.source ? [def.source] : [] }, options.hunks ?? [], entry);

  const decorations: Decorations = new Map();
  decorations.set(def.nameLine, {
    marks: [
      {
        start: def.nameColumn,
        end: def.nameEndColumn,
        cls: "self-sym",
        attrs: `data-decl="${esc(def.id)}"`,
        ...(debug ? { why: `decl · ${def.name} (${def.kind}) ${def.id}` } : {}),
      },
    ],
  });

  // External paths are absolute and machine-specific: show the basename only.
  const shownFile = def.external ? def.file.slice(def.file.lastIndexOf("/") + 1) : def.file;
  return `<article class="panel" data-node="${esc(definitionPanelId(def))}">
    <h3><code class="fn-name">${esc(def.name)}</code> <span class="badge">${esc(def.kind)}</span>${
      def.external ? ' <span class="badge">external</span>' : ""
    }</h3>
    <div class="side-loc"><code>${esc(shownFile)}:${def.startLine}–${def.endLine}</code> <span class="badge">after</span></div>
    ${renderCodePane({
      file: shownFile,
      entry,
      rows,
      lang: languageOf(def.file),
      decorations,
      focus: def,
      // The pane answers clicks by the path the language service knows.
      navigable: { side: "after", file: def.file },
      debug,
    })}
  </article>`;
}

export const EXPLORER_CSS = `
  body.explorer { max-width: none; padding: 1rem 1.2rem 2rem; }
  .viewport {
    --rail: 34px; --gap: 12px;
    position: relative; overflow: hidden; container-type: inline-size;
    height: calc(100vh - 130px);
  }
  .track {
    display: flex; gap: var(--gap); height: 100%; width: max-content;
    transform: translateX(calc(var(--rail) - var(--pos, 0) * ((100cqw - 2 * var(--rail) - var(--gap)) / 2 + var(--gap))));
    transition: transform 0.4s cubic-bezier(0.32, 0.72, 0, 1);
  }
  .track.no-anim { transition: none; }
  .panel {
    flex: none; width: calc((100cqw - 2 * var(--rail) - var(--gap)) / 2);
    height: 100%; overflow: auto; box-sizing: border-box;
    position: relative; /* the callers menu is placed within the pane */
    border: 1px solid var(--line-c); border-radius: 8px; padding: 0.7rem 0.9rem;
    background: var(--panel);
  }
  .panel > h3 { margin: 0 0 0.3rem; }
  .panel details.called-by { margin: 0.3rem 0 0.6rem; }
  .panel details.called-by summary { font-size: 0.8rem; }
  .panel details.called-by .caller-rows { margin: 0; padding: 0 0.6rem 0.6rem; }
  .caller-rows { display: flex; flex-direction: column; gap: 2px; margin: 0.2rem 0 0.5rem; }
  .caller-row {
    text-align: left; padding: 0.25rem 0.5rem; cursor: pointer;
    border: 1px solid var(--line-c); border-radius: 6px;
    background: none; color: inherit; font: inherit;
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  }
  .caller-row:hover { background: var(--accent-soft); border-color: var(--accent); }
  .caller-row[disabled] { cursor: default; opacity: 0.6; }
  .rail {
    position: absolute; top: 0; bottom: 0; width: var(--rail); z-index: 2;
    display: none; align-items: center; justify-content: center;
    border: 1px solid var(--line-c); border-radius: 8px;
    background: var(--panel); color: var(--accent); cursor: pointer;
    writing-mode: vertical-rl; text-orientation: mixed;
    font: 600 0.75rem ui-sans-serif, system-ui, sans-serif;
    letter-spacing: 0.05em; padding: 0.6rem 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .rail:hover { background: var(--accent-soft); border-color: var(--accent); }
  .rail-left { left: 0; }
  .rail-right { right: 0; }
  .viewport.can-back .rail-left { display: flex; }
  .viewport.can-fwd .rail-right { display: flex; }
  /* Visual link between a clicked symbol and the panel it opened: both get
     the same accent blue; the clicked one dims (but stays visible) as the
     panes slide. */
  .sym-link { background: var(--accent); border-radius: 3px; padding: 0 2px; transition: opacity 0.7s ease; }
  .sym-link, .sym-link * { color: var(--accent-ink) !important; }
  .sym-link.sym-dim { opacity: 0.45; }
  /* Any identifier can be asked about; it only shows as a link once hovered
     — every name underlined would read as a wall of links. One the server
     has already answered for keeps a quiet dotted underline. */
  .id { cursor: pointer; }
  .id:hover, .sym:hover { color: var(--accent); border-bottom: 1px dotted var(--accent); }
  .sym { cursor: pointer; border-bottom: 1px dotted var(--ink-faint); }
  /* Briefly, an identifier the server could not resolve. */
  .id.miss { border-bottom: 1px dashed var(--ink-faint); opacity: 0.6; }
  /* Cmd-click menu of callers; lives inside the panel so it scrolls with it. */
  .ref-menu {
    position: absolute; z-index: 5; min-width: 18rem; max-width: 34rem;
    display: flex; flex-direction: column; gap: 2px; padding: 0.4rem;
    border: 1px solid var(--line-c); border-radius: 8px; background: var(--panel);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    max-height: 60vh; overflow: auto;
  }
  .ref-menu .call-sites-label { margin: 0 0.5rem 0.2rem; }
  .ref-menu .ref-more { padding: 0.2rem 0.5rem; font-size: 0.72rem; color: var(--ink-faint); }
  .ref-menu .ref-tag { margin-left: 0.35rem; padding: 0 0.3rem; border-radius: 3px; font-size: 0.66rem; color: var(--ink-faint); background: var(--accent-soft); }
`;

/**
 * Horizontal navigation, scoped to a root element rather than the document,
 * so a page can host several independent tracks — one per slice in the
 * slice explorer, which stacks these vertically.
 *
 * Every question about a symbol goes to the local navigation server when it
 * is first asked: where is this defined (\`/definition\`), who calls it
 * (\`/references\`), what does its panel look like (\`/panel\`). Answers are
 * kept on the spans and in \`#shared-defs\`, so the page learns as it is
 * read. Without a server — a static copy — every question comes back empty
 * and the page still reads; the call-graph marks baked into function panels
 * still walk.
 */
export const EXPLORER_NAV_JS = `
function escText(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function escAttr(s) { return escText(s).replace(/"/g, "&quot;"); }
function closeRefMenu() {
  var open = document.querySelectorAll(".ref-menu");
  for (var i = 0; i < open.length; i++) open[i].remove();
}
/* Any click outside the menu, Escape, or scrolling the page dismisses it —
   a menu that drifts away from its symbol is worse than none. */
document.addEventListener("click", function (e) { if (!e.target.closest(".ref-menu")) closeRefMenu(); });
document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeRefMenu(); });
document.addEventListener("wheel", function (e) { if (!e.target.closest(".ref-menu")) closeRefMenu(); }, { passive: true });
/* Names of panels opened through the server, for the rails and history. */
window.DEFNAMES = window.DEFNAMES || {};
/* One round trip to the navigation server; null when there is none. */
function navFetch(url) {
  if (location.protocol !== "http:" && location.protocol !== "https:") return Promise.resolve(null);
  return fetch(url, { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; });
}
/* Like navFetch, but tells the caller whether the round trip actually
   reached the server: a hiccup (dropped connection, bad status) is not the
   same as the server answering "no definition here", and a caller that
   caches its result must not confuse the two — a hiccup should be retried,
   not remembered as a permanent miss. */
function navFetchTried(url) {
  if (location.protocol !== "http:" && location.protocol !== "https:") return Promise.resolve({ ok: true, data: null });
  return fetch(url, { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); })
    .then(function (data) { return { ok: true, data: data }; })
    .catch(function () { return { ok: false, data: null }; });
}
/* Let the server go when the page does. A reload fires this too — and the
   browser fetches the new page *before* the old one hears it is leaving, so
   the server waits a moment for the new page to say hello before taking the
   goodbye at its word. */
window.addEventListener("pagehide", function () {
  try { if (navigator.sendBeacon && location.protocol.indexOf("http") === 0) navigator.sendBeacon("/shutdown"); } catch (err) { /* nothing to tell */ }
});
if (location.protocol.indexOf("http") === 0) fetch("/alive", { cache: "no-store" }).catch(function () { /* no server */ });
/* Column of a span within its row's text: everything between the gutter
   and the span, counted as characters. */
function columnOf(row, span) {
  var lineno = row.querySelector(".lineno");
  if (!lineno) return -1;
  var range = document.createRange();
  range.setStartAfter(lineno);
  range.setEndBefore(span);
  return range.toString().length;
}
/* Where an identifier sits in the file its pane shows. */
function positionOf(span) {
  var pane = span.closest(".code-pane");
  var row = span.closest(".line");
  if (!pane || !row || !pane.dataset.file) return null;
  var lineno = row.querySelector(".lineno");
  var line = lineno ? parseInt(lineno.textContent, 10) : NaN;
  if (!(line > 0)) return null;
  return { file: pane.dataset.file, side: pane.dataset.side || "after", line: line, column: columnOf(row, span) };
}
/* The span at a line and column of a pane showing \`file\`, if it is rendered. */
function spanAt(scope, file, line, column) {
  var panes = scope.querySelectorAll(".code-pane");
  for (var p = 0; p < panes.length; p++) {
    if (panes[p].dataset.file !== file) continue;
    var rows = panes[p].querySelectorAll(".line");
    for (var r = 0; r < rows.length; r++) {
      var lineno = rows[r].querySelector(".lineno");
      if (!lineno || parseInt(lineno.textContent, 10) !== line) continue;
      var spans = rows[r].querySelectorAll(".id, .self-sym, .csite, .sym");
      for (var s = 0; s < spans.length; s++) if (columnOf(rows[r], spans[s]) === column) return spans[s];
      return null;
    }
  }
  return null;
}
/* What the server says a span is, asked once and remembered on the span
   (as data, so a cloned panel keeps the answer). Null for a miss, for a
   before-side pane the head checkout cannot answer for, or with no server. */
function resolveSpan(span) {
  if ("nav" in span.dataset) return Promise.resolve(span.dataset.nav ? JSON.parse(span.dataset.nav) : null);
  var at = positionOf(span);
  if (!at || at.side !== "after") return Promise.resolve(null);
  var url = "/definition?file=" + encodeURIComponent(at.file) + "&line=" + at.line + "&col=" + at.column;
  return navFetchTried(url).then(function (tried) {
    if (!tried.ok) return null; /* a hiccup, not an answer — leave the span unresolved so the next click retries */
    var answer = tried.data;
    var hit = answer && answer.id ? answer : null;
    span.dataset.nav = hit ? JSON.stringify(hit) : "";
    if (hit) {
      span.classList.add("sym");
      span.dataset.def = hit.id;
      if (!hit.self) span.dataset.target = hit.panelId;
      window.DEFNAMES[hit.panelId] = hit.name;
      if (window.DEBUG_MARKS) {
        span.dataset.why = "sym · " + hit.name + " (" + hit.kind + ") " + hit.id + " in " + hit.decl.file +
          (hit.self ? " · this is the declaration" : " · opens " + hit.panelId);
      }
    } else {
      span.classList.add("miss");
      setTimeout(function () { span.classList.remove("miss"); }, 900);
      if (window.DEBUG_MARKS) span.dataset.why = "unresolved · " + (answer && answer.why ? answer.why : "no navigation server");
    }
    return hit;
  });
}
function initExplorer(root, NAMES, onNavigate) {
  var defs = root.querySelector(".panel-defs");
  /* Definition panels are shared by every track on the page (a class is the
     same class whichever slice you reach it from), so they live once at the
     page level rather than in each track's own defs — arriving from the
     server the first time any track asks for them. */
  var sharedDefs = document.getElementById("shared-defs");
  var viewport = root.querySelector(".viewport");
  var track = root.querySelector(".track");
  var railLeft = root.querySelector(".rail-left");
  var railRight = root.querySelector(".rail-right");
  if (!viewport || !track) return;
  var pos = 0;
  /* True right after a walk up *replaces* whoever sits at the pin — a fresh,
     un-drilled caller with no accumulated depth behind it. A walk down
     always represents real progress and clears it, even one that lands
     right next to the slice: two callee hops deep deserves a way back just
     as much as ten. Left untouched by the reveal-in-place shortcut below,
     since that's a pure "look left", not a new pick. */
  var freshCaller = false;
  /* One live element per node this track has shown. A panel walked away
     from is detached, not discarded: the gaps the reader expanded and the
     answers its spans have collected come back with it on the next visit.
     The defs stay pristine templates — the first visit clones one, every
     later visit returns the same element. The slice panel is here from the
     start: it is server-rendered straight into the track, never duplicated
     into the defs, since its diff can be large and there is only ever one. */
  var live = Object.create(null);
  if (track.children[0] && track.children[0].dataset.node === "__slice__") live.__slice__ = track.children[0];
  function keep(id, panel) { live[id] = panel; return panel; }
  function esc1(id) { return window.CSS && CSS.escape ? CSS.escape(id) : id; }
  /* The panel for a node. One already shown comes back as it was — unless
     it is still on the track (a recursive walk revisits a node in view), in
     which case a copy joins it rather than tearing it out of the deck; a
     rebuild of the whole track is about to detach everything and takes the
     element itself. A first visit looks in this track's own graph panels,
     then page-wide definition panels, then — a graph node walked only in
     another slice, e.g. a function reached by that slice's own call path
     but not this one's — every other track's panel-defs. All tracks render
     their panels into the DOM up front (just hidden), so a cross-slice node
     is still right there. Only a definition the page has never shown goes
     to the server, and it is kept in #shared-defs for next time. */
  function panelFor(id, rebuilding) {
    var kept = live[id];
    if (kept) return Promise.resolve(kept.parentNode === track && !rebuilding ? kept.cloneNode(true) : kept);
    var sel = '[data-node="' + esc1(id) + '"]';
    var def = (defs && defs.querySelector(sel))
      || (sharedDefs && sharedDefs.querySelector(sel))
      || document.querySelector(".panel-defs " + sel);
    if (def) return Promise.resolve(keep(id, def.cloneNode(true)));
    if (!sharedDefs) return Promise.resolve(null);
    return navFetch("/panel?id=" + encodeURIComponent(id)).then(function (answer) {
      if (!answer || !answer.html) return null;
      if (!sharedDefs.querySelector(sel)) sharedDefs.insertAdjacentHTML("beforeend", answer.html);
      window.DEFNAMES[id] = answer.name;
      var got = sharedDefs.querySelector(sel);
      return got ? keep(id, got.cloneNode(true)) : null;
    });
  }
  function nameOf(id) { return NAMES[id] || window.DEFNAMES[id]; }
  function nodeAt(i) {
    var child = track.children[i];
    return child ? child.dataset.node : null;
  }
  function updateRails() {
    var count = track.children.length;
    track.style.setProperty("--pos", String(pos));
    /* Every lateral caller swap collapses back to right beside the pinned
       slice — so "behind" is the slice itself right after a caller pick,
       and that's not a real waypoint (the sidebar already reaches the
       slice). But once a walk down has happened since, the slice sitting
       behind reflects genuine accumulated depth, not a swap — show the
       rail regardless of what's immediately behind it. */
    var behind = pos > 0 && (nodeAt(pos - 1) !== "__slice__" || !freshCaller);
    viewport.classList.toggle("can-back", behind);
    viewport.classList.toggle("can-fwd", count > pos + 2);
    if (behind && railLeft) railLeft.textContent = "\\u25c0 " + (nameOf(nodeAt(pos - 1)) || "back");
    if (count > pos + 2 && railRight) railRight.textContent = (nameOf(nodeAt(pos + 2)) || "forward") + " \\u25b6";
  }
  function setPos(p, animate) {
    if (!animate) track.classList.add("no-anim");
    pos = p;
    updateRails();
    if (!animate) { void track.offsetWidth; track.classList.remove("no-anim"); }
  }
  /* Callee direction: append to the right of the tapped panel and slide left. */
  function walkDown(id, fromIndex) {
    return panelFor(id).then(function (panel) {
      if (!panel) return null;
      while (track.children.length > fromIndex + 1) track.removeChild(track.lastChild);
      track.appendChild(panel);
      freshCaller = false;
      setPos(Math.max(0, track.children.length - 2), true);
      return panel;
    });
  }
  /* Where the pinned slice panel sits, or -1. It is never removed — every
     walk keeps a way back to the diff that started the trail — but it does
     not always sit at the head: a caller reached from the slice's own code
     belongs to the slice's left. */
  function sliceSlot() {
    for (var i = 0; i < track.children.length; i++) {
      if (track.children[i].dataset.node === "__slice__") return i;
    }
    return -1;
  }
  /* Caller direction: the caller slides in on the LEFT of the tapped panel
     and the deck slides right, so the track always reads caller → callee —
     including when the tapped panel is the slice itself, which then sits to
     the right of its own caller. The panels the caller displaces on that
     side were a different caller chain and go; the pinned slice is the one
     that stays, so the way back to it is never lost. Each dropped panel is
     still one tap away in its callee's "called by" rows. */
  function walkUp(id, fromIndex) {
    if (fromIndex > 0 && nodeAt(fromIndex - 1) === id) {
      setPos(fromIndex - 1, true);
      return Promise.resolve(track.children[fromIndex - 1]);
    }
    return panelFor(id).then(function (panel) {
      if (!panel) return null;
      /* The stale chain runs from the tapped panel back to its anchor: the
         slice when the tapped panel sits to the slice's right, the head of
         the track when it is the slice or something already left of it. */
      var slice = sliceSlot();
      var anchor = slice >= 0 && slice < fromIndex ? slice + 1 : 0;
      var oldSlot = fromIndex - pos;
      while (fromIndex > anchor) { track.removeChild(track.children[anchor]); fromIndex--; }
      track.insertBefore(panel, track.children[anchor]);
      freshCaller = true;
      /* The tapped panel is now the caller's pair partner on the right. If
         it had been in the left slot, start the deck there so it visibly
         slides across as the caller takes its place. */
      if (oldSlot <= 0) {
        setPos(anchor + 1, false);
        setPos(anchor, true);
      } else {
        setPos(anchor, false);
      }
      return panel;
    });
  }
  var linkGen = 0;
  /* The highlighted pair the reader last made — the symbol they clicked and
     the panel it opened — as element references plus the descriptors that
     can find the marks again in a rebuilt copy of either panel. Null after
     a click that lit something up in place, or before any walk. */
  var activeLink = null;
  function clearLinks() {
    linkGen++;
    activeLink = null;
    var old = root.querySelectorAll(".sym-link");
    for (var i = 0; i < old.length; i++) old[i].classList.remove("sym-link", "sym-dim");
  }
  /* Where a clicked link sits, in terms a fresh clone of its panel can
     answer: the node it targets, the definition it resolves to, and its text
     position. A clone has not been through resolveSpan, so its identifier
     spans carry no data-target or data-def — the position is the fallback. */
  function originDesc(link) {
    if (link.classList.contains("caller-row")) {
      return link.dataset.refDef ? { def: link.dataset.refDef } : { row: link.dataset.target };
    }
    var d = { target: link.dataset.target || null, def: link.dataset.def || null };
    var at = positionOf(link);
    if (at) d.at = { file: at.file, line: at.line, col: at.column };
    return d;
  }
  /* The mark a link opens onto in its destination panel: a call site by
     position (a row from the callers menu), or a declaration by id. */
  function destDesc(link) {
    if (link.classList.contains("caller-row") && link.dataset.refDef) {
      return { site: { file: link.dataset.refFile, line: Number(link.dataset.refLine), col: Number(link.dataset.refCol) } };
    }
    return { decl: link.dataset.def || null };
  }
  function originEls(panel, d) {
    if (!d) return [];
    if (d.row) {
      var row = panel.querySelector('.caller-row[data-target="' + esc1(d.row) + '"]');
      return row ? [row.querySelector(".fn-name") || row] : [];
    }
    var found = [];
    if (d.def) found = panel.querySelectorAll('.sym[data-def="' + esc1(d.def) + '"], .self-sym[data-decl="' + esc1(d.def) + '"]');
    if (!found.length && d.target) found = panel.querySelectorAll('.csite[data-target="' + esc1(d.target) + '"], .sym[data-target="' + esc1(d.target) + '"]');
    if (!found.length && d.at) {
      var span = spanAt(panel, d.at.file, d.at.line, d.at.col);
      if (span) found = [span];
    }
    return found;
  }
  /* The declaration marks a destination descriptor names. A function panel
     has one self-sym; a definition panel may show several declarations, so
     prefer the one tagged with the link's definition id. */
  function declEls(panel, d) {
    var tagged = d && d.decl && panel.querySelector('.self-sym[data-decl="' + esc1(d.decl) + '"]');
    return tagged ? [tagged] : panel.querySelectorAll(".self-sym");
  }
  /* The one element a panel scrolls to for its anchor. */
  function anchorEl(panel, d) {
    if (d && d.site) return spanAt(panel, d.site.file, d.site.line, d.site.col);
    var decl = declEls(panel, d);
    return decl.length ? decl[0] : null;
  }
  /* Tie a clicked symbol to the panel it opened: both turn accent blue; the
     clicked one fades partially as the panes slide. A call-site anchor stays
     bright in the destination while its declarations fade, so the eye lands
     on the site the caller was chosen for. Shared by a live walk and a
     history restore, so the two cannot drift apart. */
  function applyLink(originPanel, oDesc, destPanel, dDesc) {
    clearLinks();
    var clicked = originEls(originPanel, oDesc);
    for (var j = 0; j < clicked.length; j++) clicked[j].classList.add("sym-link");
    var dest = declEls(destPanel, dDesc);
    for (var d = 0; d < dest.length; d++) dest[d].classList.add("sym-link", "sym-dim");
    var anchor = anchorEl(destPanel, dDesc);
    if (anchor && dDesc && dDesc.site) anchor.classList.add("sym-link");
    if (anchor) revealInPanel(destPanel, anchor);
    activeLink = { origin: originPanel, originDesc: oDesc, dest: destPanel, destDesc: dDesc };
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        for (var k = 0; k < clicked.length; k++) clicked[k].classList.add("sym-dim");
      });
    });
  }
  /* A link just walked to \`dest\`: remember on the panel what it was opened
     for, so a rebuilt copy can scroll to the same spot, and light the pair. */
  function linkSymbols(link, dest) {
    var dDesc = destDesc(link);
    dest.__anchor = dDesc;
    applyLink(link.closest(".panel") || root, originDesc(link), dest, dDesc);
  }
  /* A panel opens at the top of the region it renders, but the declaration
     that was asked for can sit far below that — off the bottom entirely for
     a symbol declared late in a long region. Scroll it into the panel's own
     scrollport, a third of the way down so its body reads underneath it,
     and leave a panel that already shows it where the reader left it. */
  function revealInPanel(panel, el) {
    if (!panel || !el) return;
    var p = panel.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (!p.height || !r.height) return;
    if (r.top >= p.top && r.bottom <= p.bottom) return;
    var offset = r.top - p.top + panel.scrollTop;
    var max = panel.scrollHeight - panel.clientHeight;
    panel.scrollTop = Math.max(0, Math.min(offset - panel.clientHeight / 3, max));
  }
  /* Is the element fully inside the panel's scrollport? Panels are their own
     scroll containers, so the panel's rect is the viewport that matters. */
  function inView(panel, el) {
    var p = panel.getBoundingClientRect(), r = el.getBoundingClientRect();
    return r.top >= p.top && r.bottom <= p.bottom && r.height > 0;
  }
  /* A symbol whose declaration is already on screen in the same pane: light
     up the pair in place rather than opening a panel for what the reader can
     see. No scroll — moving the pane would defeat the point. Sibling uses
     may still be plain, un-clicked id spans with no resolved position of
     their own, so the full set comes from the server rather than the DOM. */
  function linkInPlace(link, decl, defId) {
    clearLinks();
    var gen = linkGen;
    var scope = link.closest(".panel") || root;
    decl.classList.add("sym-link");
    navFetch("/references?id=" + encodeURIComponent(defId)).then(function (refs) {
      if (!refs || gen !== linkGen) return;
      for (var r = 0; r < refs.sites.length; r++) {
        var site = refs.sites[r];
        var span = spanAt(scope, site.file, site.line, site.startColumn);
        if (span) span.classList.add("sym-link");
      }
    });
  }
  /* Every action that lands the viewport on a particular node — walking,
     or just paging the rail to reveal one already on the track — reports
     that node's id here. The history list decides for itself whether
     that's new ground or a spot it's already visited. */
  function report(id) {
    if (!onNavigate) return;
    var children = Array.prototype.slice.call(track.children);
    var link = null;
    if (activeLink) {
      var from = children.indexOf(activeLink.origin), to = children.indexOf(activeLink.dest);
      if (from >= 0 && to >= 0) link = { from: from, fromDesc: activeLink.originDesc, to: to, toDesc: activeLink.destDesc };
    }
    onNavigate({
      id: id,
      ids: children.map(function (c) { return c.dataset.node; }),
      anchors: children.map(function (c) { return c.__anchor || null; }),
      link: link,
      pos: pos,
    });
  }
  /* A resolved identifier: its declaration in view in the same pane lights
     up in place; otherwise its panel slides in. A click on the declaration
     itself has nowhere to go. */
  function openDefinition(link, panel, i, answer) {
    var decl = spanAt(panel, answer.decl.file, answer.decl.line, answer.decl.column);
    if (decl && inView(panel, decl)) { linkInPlace(link, decl, answer.id); return; }
    if (answer.self) return;
    walkDown(answer.panelId, i).then(function (dest) {
      if (!dest) return;
      linkSymbols(link, dest);
      report(answer.panelId);
    });
  }
  root.addEventListener("click", function (e) {
    /* Cmd-click (Ctrl-click elsewhere) on a symbol opens its callers menu;
       a right-click would fight the browser's own menu. */
    var sym = e.target.closest(".id, .self-sym, .csite");
    if ((e.metaKey || e.ctrlKey) && sym) {
      openRefMenu(e, sym);
      return;
    }
    var link = e.target.closest(".csite, .caller-row, .id");
    if (link) {
      var panel = link.closest(".panel");
      var i = Array.prototype.indexOf.call(track.children, panel);
      if (i < 0) return;
      if (link.classList.contains("caller-row")) {
        if (!link.dataset.target) return;
        walkUp(link.dataset.target, i).then(function (dest) {
          if (!dest) return;
          /* A row from the callers menu: the menu is gone once the caller
             slides in, so the trail marker is the symbol the menu was opened
             on, and the destination is the call site inside the caller —
             linkSymbols reads both off the row's data attributes. */
          linkSymbols(link, dest);
          if (link.dataset.refDef) closeRefMenu();
          report(link.dataset.target);
        });
        return;
      }
      if (link.classList.contains("csite")) {
        walkDown(link.dataset.target, i).then(function (dest) {
          if (!dest) return;
          linkSymbols(link, dest);
          report(link.dataset.target);
        });
        return;
      }
      resolveSpan(link).then(function (answer) {
        if (answer) openDefinition(link, panel, i, answer);
      });
      return;
    }
    if (e.target.closest(".rail-left")) {
      var backTo = Math.max(0, pos - 1);
      setPos(backTo, true);
      report(nodeAt(backTo));
    } else if (e.target.closest(".rail-right")) {
      var fwdTo = Math.min(track.children.length - 2, pos + 1);
      setPos(fwdTo, true);
      report(nodeAt(fwdTo + 1));
    }
  });
  /* A menu of who calls (or, for a class or constant, who references) a
     symbol's definition, fetched when asked. Rows are caller-rows, so the
     click handler above walks up into the caller exactly as a panel's own
     called-by rows do. */
  function openRefMenu(e, sym) {
    e.preventDefault();
    e.stopPropagation();
    closeRefMenu();
    var panel = sym.closest(".panel");
    var menu = document.createElement("div");
    menu.className = "ref-menu";
    menu.innerHTML = '<div class="call-sites-label">callers</div><div class="ref-more">resolving\\u2026</div>';
    var rect = panel.getBoundingClientRect();
    panel.appendChild(menu);
    /* Just under the cursor, pulled back inside the pane if it would spill out. */
    var left = e.clientX - rect.left + panel.scrollLeft;
    var top = e.clientY - rect.top + panel.scrollTop + 6;
    left = Math.max(0, Math.min(left, panel.scrollLeft + panel.clientWidth - menu.offsetWidth - 8));
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    /* Always answer the gesture: a local or an unresolved symbol has no
       callers to list, and silence reads as a broken shortcut. */
    var known = sym.dataset.decl || sym.dataset.def;
    var idOf = known ? Promise.resolve({ id: known }) : resolveSpan(sym);
    idOf.then(function (answer) {
      if (!answer || !answer.id) return null;
      return navFetch("/references?id=" + encodeURIComponent(answer.id)).then(function (refs) {
        return refs ? { id: answer.id, refs: refs } : null;
      });
    }).then(function (found) {
      if (!menu.isConnected) return;
      var refs = found ? found.refs : { kind: "calls", sites: [] };
      var html = '<div class="call-sites-label">' + (refs.kind === "calls" ? "called by" : "referenced by") + "</div>";
      if (!refs.sites.length) html += '<div class="ref-more">no callers found</div>';
      for (var r = 0; r < refs.sites.length; r++) {
        var site = refs.sites[r];
        html += '<button class="caller-row"' +
          (site.panelId ? ' data-target="' + escAttr(site.panelId) + '"' : " disabled") +
          ' data-ref-def="' + escAttr(found.id) + '" data-ref-file="' + escAttr(site.file) + '"' +
          ' data-ref-line="' + site.line + '" data-ref-col="' + site.startColumn + '">\\u2196 <code class="fn-name">' + escText(site.enclosingName) +
          '</code> <span class="loc">L' + site.line + "</span>" +
          (site.indirect ? '<span class="ref-tag" title="passed as a value, not called here">passed</span>' : "") +
          " <code>" + escText(site.snippet) + "</code></button>";
      }
      menu.innerHTML = html;
      left = Math.max(0, Math.min(left, panel.scrollLeft + panel.clientWidth - menu.offsetWidth - 8));
      menu.style.left = left + "px";
    });
  }
  /* External restore point for a history entry: rebuild the track from a
     saved list of node ids and re-settle the viewport at the saved slot.
     Panels come back through the same lookup a walk uses — the live element
     each node already has, or a fetch for one the page has never shown. A
     node listed twice (a recursive walk) gets a copy for its second slot.
     One still on the track keeps the scroll the reader left it at; one that
     was detached lost its scroll along with its layout, and is scrolled
     back to the anchor it was originally opened for. The highlighted pair
     is rebuilt last from the same descriptors a live walk records — which
     brings the step's own destination mark back into view even in a panel
     the reader has since scrolled away from, since that mark is what the
     step *is*. */
  root.__restore = function (ids, newPos, anchors, link) {
    var panels = [];
    return ids.reduce(function (chain, id, i) {
      return chain.then(function () {
        return panelFor(id, true).then(function (panel) {
          if (!panel) return;
          var copy = panels.some(function (p) { return p.el === panel; });
          var el = copy ? panel.cloneNode(true) : panel;
          el.__anchor = anchors && anchors[i] ? anchors[i] : null;
          panels.push({ el: el, onTrack: !copy && el.parentNode === track, scrollTop: el.scrollTop });
        });
      });
    }, Promise.resolve()).then(function () {
      track.innerHTML = "";
      for (var r = 0; r < panels.length; r++) track.appendChild(panels[r].el);
      setPos(Math.max(0, Math.min(newPos, track.children.length - 2)), true);
      clearLinks();
      for (var f = 0; f < panels.length; f++) {
        var p = panels[f];
        if (p.onTrack) { p.el.scrollTop = p.scrollTop; continue; }
        var el = anchorEl(p.el, p.el.__anchor);
        if (el) revealInPanel(p.el, el);
      }
      var from = link && track.children[link.from], to = link && track.children[link.to];
      if (from && to) applyLink(from, link.fromDesc, to, link.toDesc);
    });
  };
  updateRails();
}
`;

export function renderCallPathExplorerHtml(result: CallPathResult): string {
  const index = buildFileIndex(result.files);
  const root = result.nodes.find((n) => n.id === result.rootId);
  if (!root) throw new Error("root node missing from call graph");

  const panels = result.nodes.map((n) => renderPanel(n, result, index)).join("\n");
  const rootPanel = renderPanel(root, result, index);
  const names = Object.fromEntries(result.nodes.map((n) => [n.id, n.name]));

  return `<!doctype html>
<html lang="en">
<head>
${pageHead(result, EXPLORER_CSS)}
</head>
<body class="explorer">
${pageHeader(result)}
<p class="missing">tap a highlighted call to walk down the stack; tap a "called by" row to walk up</p>

<div class="viewport" data-root="${esc(result.rootId)}">
  <button class="rail rail-left"></button>
  <button class="rail rail-right"></button>
  <div class="track">${rootPanel}</div>
</div>

<div id="panel-defs" class="panel-defs" hidden>${panels}</div>

<script type="application/json" id="node-names">${JSON.stringify(names).replaceAll("</", "<\\/")}</script>
${dataScripts(result, index)}
<script>
${GAP_JS}
${WRAP_JS}
${SCOPE_JS}
${EXPLORER_NAV_JS}
initExplorer(document.body, JSON.parse(document.getElementById("node-names").textContent));
</script>
</body>
</html>
`;
}
