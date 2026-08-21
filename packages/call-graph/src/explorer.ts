import { escapeHtml as esc, languageOf, type Mark } from "./highlight.js";
import {
  buildFileIndex,
  dataScripts,
  GAP_JS,
  pageHead,
  pageHeader,
  presenceBadge,
  renderCodeBlock,
  renderHunksBlock,
  type Decorations,
  type FileIndex,
} from "./html.js";
import type { CallPathResult, CallSite, DiffHunk, PathNode } from "./types.js";

/** New-file line numbers added by these hunks. */
function addedLines(hunks: DiffHunk[]): Set<number> {
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

function sitesFor(side: "before" | "after", edge: { before: CallSite[]; after: CallSite[] }): CallSite[] {
  return side === "after" ? edge.after : edge.before;
}

/** Lines of surrounding file context shown around a function, like `diff -U10`. */
const PANEL_CONTEXT = 10;

export function renderPanel(node: PathNode, result: CallPathResult, index: FileIndex): string {
  const side: "before" | "after" = node.after ? "after" : "before";
  const snapshot = (node.after ?? node.before)!;
  const entry = index.get(`${side}:${snapshot.file}`);

  // Pad the visible source with context from the embedded file so tiny
  // functions (one-line arrows, etc.) aren't shown as a lone line.
  const segments = entry
    ? [
        {
          startLine: Math.max(1, snapshot.startLine - PANEL_CONTEXT),
          lines: entry.lines.slice(
            Math.max(1, snapshot.startLine - PANEL_CONTEXT) - 1,
            Math.min(entry.lines.length, snapshot.endLine + PANEL_CONTEXT),
          ),
        },
      ]
    : snapshot.source;

  // Decorations: PR-added lines tinted; each outgoing call tappable. Tint
  // only within the function itself — surrounding context lines may also be
  // "added" (e.g. in a new file) but should read as plain context.
  const decorations: Decorations = new Map();
  if (side === "after") {
    for (const line of addedLines(node.hunks)) {
      if (line >= snapshot.startLine && line <= snapshot.endLine) {
        decorations.set(line, { cls: ["diff-add"] });
      }
    }
  }
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
        { start: namePos.column, end: namePos.column + bareName.length, cls: "self-sym" },
      ],
    });
  }

  // Incoming edges become tappable "called by" rows.
  const nodeName = new Map(result.nodes.map((n) => [n.id, n.name]));
  const callerRows = result.edges
    .filter((edge) => edge.to === node.id)
    .flatMap((edge) => {
      const sites = sitesFor(side, edge).length ? sitesFor(side, edge) : sitesFor(side === "after" ? "before" : "after", edge);
      return sites.slice(0, 3).map(
        (site) =>
          `<button class="caller-row" data-target="${esc(edge.from)}">↖ <code class="fn-name">${esc(
            nodeName.get(edge.from) ?? edge.from,
          )}</code> <span class="loc">L${site.line}</span> <code>${esc(site.snippet)}</code></button>`,
      );
    })
    .join("");

  return `<article class="panel" data-node="${esc(node.id)}">
    <h3><code class="fn-name">${esc(node.name)}</code> ${presenceBadge(node)}</h3>
    <div class="side-loc"><code>${esc(snapshot.file)}:${snapshot.startLine}–${snapshot.endLine}</code> <span class="badge">${side}</span>${
      node.expanded ? "" : ' <span class="badge">boundary</span>'
    }</div>
    ${callerRows ? `<div class="call-sites-label">called by — tap to walk up</div><div class="caller-rows">${callerRows}</div>` : ""}
    ${node.hunks.length ? `<details class="fn"><summary>diff (${node.hunks.length} hunk${node.hunks.length > 1 ? "s" : ""})</summary><div class="fn-body">${renderHunksBlock(node.hunks, entry, languageOf(node.file))}</div></details>` : ""}
    ${renderCodeBlock(segments, { entry, gaps: true, lang: languageOf(snapshot.file), decorations })}
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
    border: 1px solid var(--line-c); border-radius: 8px; padding: 0.7rem 0.9rem;
    background: var(--panel);
  }
  .panel > h3 { margin: 0 0 0.3rem; }
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
`;

/**
 * Horizontal navigation, scoped to a root element rather than the document,
 * so a page can host several independent tracks — one per slice in the
 * slice explorer, which stacks these vertically.
 */
export const EXPLORER_NAV_JS = `
function initExplorer(root, NAMES) {
  var defs = root.querySelector(".panel-defs");
  var viewport = root.querySelector(".viewport");
  var track = root.querySelector(".track");
  var railLeft = root.querySelector(".rail-left");
  var railRight = root.querySelector(".rail-right");
  if (!viewport || !track) return;
  var pos = 0;
  function esc1(id) { return window.CSS && CSS.escape ? CSS.escape(id) : id; }
  function panelFor(id) {
    var def = defs && defs.querySelector('[data-node="' + esc1(id) + '"]');
    return def ? def.cloneNode(true) : null;
  }
  function nodeAt(i) {
    var child = track.children[i];
    return child ? child.dataset.node : null;
  }
  function updateRails() {
    var count = track.children.length;
    track.style.setProperty("--pos", String(pos));
    viewport.classList.toggle("can-back", pos > 0);
    viewport.classList.toggle("can-fwd", count > pos + 2);
    if (pos > 0 && railLeft) railLeft.textContent = "\\u25c0 " + (NAMES[nodeAt(pos - 1)] || "back");
    if (count > pos + 2 && railRight) railRight.textContent = (NAMES[nodeAt(pos + 2)] || "forward") + " \\u25b6";
  }
  function setPos(p, animate) {
    if (!animate) track.classList.add("no-anim");
    pos = p;
    updateRails();
    if (!animate) { void track.offsetWidth; track.classList.remove("no-anim"); }
  }
  /* One direction of travel: every walk — into a callee or up to a caller —
     appends to the right, so the track is the navigation history and the
     left rail always retraces the exact path back to where the reader
     started. A node already on the track is revealed in place instead of
     re-opened, keeping the panels ahead of it as forward history. */
  function open(id, fromIndex) {
    for (var j = 0; j < track.children.length; j++) {
      if (nodeAt(j) !== id) continue;
      /* Behind the reader: show it in the left slot, keeping the panel they
         tapped in visible. Ahead: show it in the right slot. */
      var p = j <= fromIndex ? j : j - 1;
      setPos(Math.max(0, Math.min(p, track.children.length - 2)), true);
      return track.children[j];
    }
    var panel = panelFor(id);
    if (!panel) return null;
    while (track.children.length > fromIndex + 1) track.removeChild(track.lastChild);
    track.appendChild(panel);
    setPos(Math.max(0, track.children.length - 2), true);
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
      var line = link.closest(".line") || link.parentNode;
      clicked = line.querySelectorAll('.csite[data-target="' + esc1(link.dataset.target) + '"]');
    }
    for (var j = 0; j < clicked.length; j++) clicked[j].classList.add("sym-link");
    var dest = destPanel ? destPanel.querySelectorAll(".self-sym") : [];
    for (var d = 0; d < dest.length; d++) dest[d].classList.add("sym-link", "sym-dim");
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        for (var k = 0; k < clicked.length; k++) clicked[k].classList.add("sym-dim");
      });
    });
  }
  root.addEventListener("click", function (e) {
    var link = e.target.closest(".csite, .caller-row");
    if (link && link.dataset.target) {
      var panel = link.closest(".panel");
      var i = Array.prototype.indexOf.call(track.children, panel);
      if (i < 0) return;
      var dest = open(link.dataset.target, i);
      if (dest) linkSymbols(link, dest);
      return;
    }
    if (e.target.closest(".rail-left")) setPos(Math.max(0, pos - 1), true);
    else if (e.target.closest(".rail-right")) setPos(Math.min(track.children.length - 2, pos + 1), true);
  });
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
<p class="missing">tap a highlighted call to walk down the stack; tap a "called by" row to walk up — the left rail retraces your path</p>

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
${EXPLORER_NAV_JS}
initExplorer(document.body, JSON.parse(document.getElementById("node-names").textContent));
</script>
</body>
</html>
`;
}
