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
  type Decorations,
  type FileEntry,
  type FileIndex,
} from "./html.js";
import { NavIndex, definitionPanelId } from "./navLinks.js";
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
 * padded with context on both sides. Shared with the navigation resolver so
 * it asks about exactly the lines that render.
 */
export function panelRange(
  span: { startLine: number; endLine: number },
  lineCount: number,
): [number, number] {
  return [Math.max(1, span.startLine - PANEL_CONTEXT), Math.min(lineCount, span.endLine + PANEL_CONTEXT)];
}

/** Layer nav link + declaration marks onto every line of a range. */
function addNavMarks(
  decorations: Decorations,
  nav: NavIndex,
  file: string,
  from: number,
  to: number,
): void {
  if (nav.empty) return;
  for (let n = from; n <= to; n++) {
    const existing = decorations.get(n) ?? {};
    const marks = nav.marksFor(file, n, existing.marks ?? []);
    if (marks.length) decorations.set(n, { ...existing, marks: [...(existing.marks ?? []), ...marks] });
  }
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
  nav: NavIndex = new NavIndex(undefined),
): string {
  const side: "before" | "after" = node.after ? "after" : "before";
  const snapshot = (node.after ?? node.before)!;
  const entry = index.get(`${side}:${snapshot.file}`);
  const range = entry ? panelRange(snapshot, entry.lines.length) : null;

  // Hunks are in head coordinates; a before-only function shows plain source.
  const rows = panelRows(snapshot, side === "after" ? node.hunks : [], entry);

  // Overlays on the diff: each outgoing call tappable, the declared name marked.
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
        ...(nav.debug ? { why: `csite · call-graph edge ${node.id} → ${edge.to}` } : {}),
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
  // When the navigation data knows this declaration, its mark (which carries
  // the definition id) takes the place of the text-search one.
  const navDeclares =
    namePos !== null &&
    side === "after" &&
    nav.declMarks(snapshot.file, namePos.line).some((m) => m.start === namePos!.column);
  if (namePos && !navDeclares) {
    const existing = decorations.get(namePos.line) ?? {};
    decorations.set(namePos.line, {
      ...existing,
      marks: [
        ...(existing.marks ?? []),
        {
          start: namePos.column,
          end: namePos.column + bareName.length,
          cls: "self-sym",
          ...(nav.debug
            ? { why: `decl · ${node.name}, graph node ${node.id} (${nameFromService ? "language service" : "text search"})` }
            : {}),
        },
      ],
    });
  }
  if (side === "after") {
    const [from, to] = range ?? [snapshot.startLine, snapshot.endLine];
    addNavMarks(decorations, nav, snapshot.file, from, to);
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
      debug: nav.debug,
    })}
  </article>`;
}

/**
 * A panel for a definition the call graph did not reach — a class, a
 * constant, an import, a local, or something in a dependency. Same card as
 * a function's, minus the call-graph parts (no called-by rows, no diff).
 */
export function renderDefinitionPanel(def: DefinitionTarget, index: FileIndex, nav: NavIndex): string {
  // A window wins when present: the file is not on the page whole.
  const entry = def.external || def.source ? undefined : index.get(`after:${def.file}`);
  if (!entry && !def.source) return "";
  const rows = panelRows({ ...def, source: def.source ? [def.source] : [] }, [], entry);

  const decorations: Decorations = new Map();
  decorations.set(def.nameLine, {
    marks: [
      {
        start: def.nameColumn,
        end: def.nameEndColumn,
        cls: "self-sym",
        attrs: `data-decl="${esc(def.id)}"`,
        ...(nav.debug ? { why: `decl · ${def.name} (${def.kind}) ${def.id}` } : {}),
      },
    ],
  });
  if (!def.external) {
    const [from, to] = entry
      ? panelRange(def, entry.lines.length)
      : [def.source!.startLine, def.source!.startLine + def.source!.lines.length - 1];
    // The declaration's own mark is already placed above; marksFor dedupes it.
    addNavMarks(decorations, nav, def.file, from, to);
  }

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
      debug: nav.debug,
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
  /* Any symbol with a known definition: quieter than a call mark, so a
     panel full of resolvable names does not read as a wall of tint. */
  .sym { cursor: pointer; border-bottom: 1px dotted var(--ink-faint); }
  .sym:hover { color: var(--accent); border-bottom-color: var(--accent); }
  /* Cmd-click menu of callers; lives inside the panel so it scrolls with it. */
  .ref-menu {
    position: absolute; z-index: 5; min-width: 18rem; max-width: 34rem;
    display: flex; flex-direction: column; gap: 2px; padding: 0.4rem;
    border: 1px solid var(--line-c); border-radius: 8px; background: var(--panel);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  }
  .ref-menu .call-sites-label { margin: 0 0.5rem 0.2rem; }
  .ref-menu .ref-more { padding: 0.2rem 0.5rem; font-size: 0.72rem; color: var(--ink-faint); }
  .ref-site.sym-link { background: var(--accent); }
`;

/**
 * Horizontal navigation, scoped to a root element rather than the document,
 * so a page can host several independent tracks — one per slice in the
 * slice explorer, which stacks these vertically.
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
document.addEventListener("wheel", closeRefMenu, { passive: true });
function initExplorer(root, NAMES, onNavigate) {
  var defs = root.querySelector(".panel-defs");
  /* Definition panels are shared by every track on the page (a class is the
     same class whichever slice you reach it from), so they live once at the
     page level rather than in each track's own defs. */
  var sharedDefs = document.getElementById("shared-defs");
  var DEFNAMES = window.DEFNAMES || {};
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
  /* The slice panel (when this track has one) is server-rendered directly
     into the track, not duplicated into the defs — its diff content can be
     large, and there's only ever one. Keep a live reference so a history
     restore can move it back in without needing a def to clone. */
  var pinnedNode = track.children[0] && track.children[0].dataset.node === "__slice__" ? track.children[0] : null;
  function esc1(id) { return window.CSS && CSS.escape ? CSS.escape(id) : id; }
  function panelFor(id) {
    if (pinnedNode && id === "__slice__") return pinnedNode;
    var def = (defs && defs.querySelector('[data-node="' + esc1(id) + '"]'))
      || (sharedDefs && sharedDefs.querySelector('[data-node="' + esc1(id) + '"]'));
    return def ? def.cloneNode(true) : null;
  }
  function nameOf(id) { return NAMES[id] || DEFNAMES[id]; }
  function nodeAt(i) {
    var child = track.children[i];
    return child ? child.dataset.node : null;
  }
  function updateRails() {
    var count = track.children.length;
    track.style.setProperty("--pos", String(pos));
    /* The pinned slice panel always sits at index 0, and every lateral
       caller swap collapses back to right beside it — so "behind" is the
       slice itself right after a caller pick, and that's not a real
       waypoint (the sidebar already reaches the slice). But once a walk
       down has happened since, the slice sitting behind reflects genuine
       accumulated depth, not a swap — show the rail regardless of what's
       immediately behind it. */
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
    var panel = panelFor(id);
    if (!panel) return null;
    while (track.children.length > fromIndex + 1) track.removeChild(track.lastChild);
    track.appendChild(panel);
    freshCaller = false;
    setPos(Math.max(0, track.children.length - 2), true);
    return panel;
  }
  /* Caller direction: reveal the caller on the LEFT and slide right, so the
     track always reads caller → callee. The slice panel is pinned at the
     head of the track — the caller slots in after it, so the way back to
     the slice is never lost. Only the panels between the pin and the tapped
     one go: they were a different caller chain, and each stays one tap away
     in its callee's "called by" rows. */
  function walkUp(id, fromIndex) {
    if (fromIndex > 0 && nodeAt(fromIndex - 1) === id) {
      setPos(fromIndex - 1, true);
      return track.children[fromIndex - 1];
    }
    var panel = panelFor(id);
    if (!panel) return null;
    var pin = nodeAt(0) === "__slice__" ? 1 : 0;
    var oldSlot = fromIndex - pos;
    while (fromIndex > pin) { track.removeChild(track.children[pin]); fromIndex--; }
    track.insertBefore(panel, track.children[pin] || null);
    freshCaller = true;
    if (oldSlot <= 0) {
      setPos(pin + 1, false);
      setPos(pin, true);
    } else {
      setPos(pin, false);
    }
    return panel;
  }
  /* Tie the clicked symbol to the panel it opened: both turn accent blue;
     the clicked one fades partially as the panes slide. */
  function linkSymbols(link, destPanel) {
    var old = root.querySelectorAll(".sym-link");
    for (var i = 0; i < old.length; i++) old[i].classList.remove("sym-link", "sym-dim");
    var clicked;
    if (link.classList.contains("caller-row")) {
      clicked = [link.querySelector(".fn-name") || link];
    } else {
      var scope = link.closest(".panel") || root;
      var t = esc1(link.dataset.target);
      clicked = scope.querySelectorAll('.csite[data-target="' + t + '"], .sym[data-target="' + t + '"]');
    }
    for (var j = 0; j < clicked.length; j++) clicked[j].classList.add("sym-link");
    /* The destination mark is the declaration this link resolves to. A
       function panel has one self-sym; a definition panel may show several
       declarations, so prefer the one tagged with the link's definition id. */
    var dest = [];
    if (destPanel) {
      var tagged = link.dataset.def && destPanel.querySelector('.self-sym[data-decl="' + esc1(link.dataset.def) + '"]');
      dest = tagged ? [tagged] : destPanel.querySelectorAll(".self-sym");
    }
    for (var d = 0; d < dest.length; d++) dest[d].classList.add("sym-link", "sym-dim");
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        for (var k = 0; k < clicked.length; k++) clicked[k].classList.add("sym-dim");
      });
    });
  }
  /* Is the element fully inside the panel's scrollport? Panels are their own
     scroll containers, so the panel's rect is the viewport that matters. */
  function inView(panel, el) {
    var p = panel.getBoundingClientRect(), r = el.getBoundingClientRect();
    return r.top >= p.top && r.bottom <= p.bottom && r.height > 0;
  }
  /* A symbol whose declaration is already on screen in the same pane: light
     up the pair in place rather than opening a panel for what the reader can
     see. No scroll — moving the pane would defeat the point. */
  function linkInPlace(link, decl) {
    var old = root.querySelectorAll(".sym-link");
    for (var i = 0; i < old.length; i++) old[i].classList.remove("sym-link", "sym-dim");
    var scope = link.closest(".panel") || root;
    var uses = scope.querySelectorAll('.sym[data-def="' + esc1(link.dataset.def) + '"]');
    for (var u = 0; u < uses.length; u++) uses[u].classList.add("sym-link");
    decl.classList.add("sym-link");
  }
  /* Every action that lands the viewport on a particular node — walking,
     or just paging the rail to reveal one already on the track — reports
     that node's id here. The history list decides for itself whether
     that's new ground or a spot it's already visited. */
  function report(id) {
    if (!onNavigate) return;
    onNavigate({
      id: id,
      ids: Array.prototype.map.call(track.children, function (c) { return c.dataset.node; }),
      pos: pos,
    });
  }
  root.addEventListener("click", function (e) {
    /* Cmd-click (Ctrl-click elsewhere) on a symbol opens its callers menu;
       a right-click would fight the browser's own menu. */
    if ((e.metaKey || e.ctrlKey) && e.target.closest(".sym, .self-sym")) {
      openRefMenu(e, e.target.closest(".sym, .self-sym"));
      return;
    }
    var link = e.target.closest(".csite, .caller-row, .sym");
    if (link && (link.dataset.target || link.dataset.def)) {
      var panel = link.closest(".panel");
      var i = Array.prototype.indexOf.call(track.children, panel);
      if (i < 0) return;
      if (link.classList.contains("sym") && link.dataset.def) {
        var decl = panel.querySelector('.self-sym[data-decl="' + esc1(link.dataset.def) + '"]');
        if (decl && inView(panel, decl)) { linkInPlace(link, decl); return; }
        if (!link.dataset.target) return;
      }
      var dest = link.classList.contains("caller-row")
        ? walkUp(link.dataset.target, i)
        : walkDown(link.dataset.target, i);
      if (dest) {
        linkSymbols(link, dest);
        /* A row from the callers menu: the menu is gone once the caller
           slides in, so the trail marker is the symbol the menu was opened
           on, and the destination is the call site inside the caller. */
        if (link.dataset.refDef) {
          var origin = panel.querySelectorAll('.sym[data-def="' + esc1(link.dataset.refDef) + '"], .self-sym[data-decl="' + esc1(link.dataset.refDef) + '"]');
          for (var o = 0; o < origin.length; o++) origin[o].classList.add("sym-link", "sym-dim");
          var sites = dest.querySelectorAll('.ref-site[data-ref-of="' + esc1(link.dataset.refDef) + '"]');
          for (var s = 0; s < sites.length; s++) sites[s].classList.add("sym-link");
          var row = dest.querySelector('.ref-site[data-ref-of="' + esc1(link.dataset.refDef) + '"]');
          if (row) row.scrollIntoView({ block: "center" });
          closeRefMenu();
        }
        report(link.dataset.target);
      }
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
     symbol's definition. Rows are caller-rows, so the click handler above
     walks up into the caller exactly as a panel's own called-by rows do. */
  function openRefMenu(e, sym) {
    var id = sym.dataset.def || sym.dataset.decl;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    closeRefMenu();
    var panel = sym.closest(".panel");
    var menu = document.createElement("div");
    menu.className = "ref-menu";
    /* Always answer the gesture: a local or an unresolved symbol has no
       callers to list, and silence reads as a broken shortcut. */
    var refs = (window.REFS && window.REFS[id]) || { kind: "calls", total: 0, sites: [] };
    var html = '<div class="call-sites-label">' + (refs.kind === "calls" ? "called by" : "referenced by") + "</div>";
    if (!refs.sites.length) html += '<div class="ref-more">no callers found</div>';
    for (var r = 0; r < refs.sites.length; r++) {
      var site = refs.sites[r];
      html += '<button class="caller-row"' +
        (site.panelId ? ' data-target="' + escAttr(site.panelId) + '"' : " disabled") +
        ' data-ref-def="' + escAttr(id) + '">\\u2196 <code class="fn-name">' + escText(site.enclosingName) +
        '</code> <span class="loc">L' + site.line + "</span> <code>" + escText(site.snippet) + "</code></button>";
    }
    if (refs.total > refs.sites.length) {
      html += '<div class="ref-more">+' + (refs.total - refs.sites.length) + " more</div>";
    }
    menu.innerHTML = html;
    var rect = panel.getBoundingClientRect();
    panel.appendChild(menu);
    /* Just under the cursor, pulled back inside the pane if it would spill out. */
    var left = e.clientX - rect.left + panel.scrollLeft;
    var top = e.clientY - rect.top + panel.scrollTop + 6;
    left = Math.max(0, Math.min(left, panel.scrollLeft + panel.clientWidth - menu.offsetWidth - 8));
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }
  /* External restore point for a history entry: rebuild the track from a
     saved list of node ids and re-settle the viewport at the saved slot. */
  root.__restore = function (ids, newPos) {
    track.innerHTML = "";
    for (var r = 0; r < ids.length; r++) {
      var restored = panelFor(ids[r]);
      if (restored) track.appendChild(restored);
    }
    setPos(Math.max(0, Math.min(newPos, track.children.length - 2)), true);
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
${SCOPE_JS}
${EXPLORER_NAV_JS}
initExplorer(document.body, JSON.parse(document.getElementById("node-names").textContent));
</script>
</body>
</html>
`;
}
