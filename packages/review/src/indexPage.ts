/**
 * The two pages the server renders itself, rather than from a slicing run:
 * the index of every PR it holds, and the placeholder a PR's own URL shows
 * while it is still being built. Both poll the server, so a PR added from
 * another terminal appears without a reload, and a building one turns into
 * its explorer as soon as it is ready.
 */

import { escapeHtml as esc, REPORT_CSS } from "@deep-review/call-graph";
import type { PrView } from "./registry.js";

const INDEX_CSS = `
  body { max-width: 60rem; }
  header h1 { margin: 0 0 0.2rem; font-size: 1.3rem; }
  .rows { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1.25rem; }
  .row { display: grid; grid-template-columns: 1fr auto; gap: 0.75rem 1rem; align-items: start;
         padding: 0.8rem 0.9rem; border: 1px solid var(--line-c); border-radius: 8px;
         background: var(--panel); }
  .row.failed { border-color: var(--del-edge); }
  .row .name { font-family: var(--mono); font-size: 0.85rem; color: var(--ink-soft); }
  .row .title { font-weight: 600; letter-spacing: -0.01em; }
  .row a.title { color: inherit; text-decoration: none; }
  .row a.title:hover { color: var(--accent); }
  .row .facts { color: var(--ink-soft); font-size: 0.85rem; margin-top: 0.15rem; }
  .row .why { color: var(--del-edge); font-size: 0.85rem; margin-top: 0.15rem; }
  .row .last { font-family: var(--mono); font-size: 0.78rem; color: var(--ink-faint);
               margin-top: 0.3rem; white-space: pre-wrap; }
  .side-actions { display: flex; align-items: center; gap: 0.5rem; }
  .pill { font-size: 0.72rem; letter-spacing: 0.03em; text-transform: uppercase;
          padding: 0.15rem 0.5rem; border-radius: 999px; border: 1px solid var(--line-c);
          color: var(--ink-soft); background: var(--panel-2); white-space: nowrap; }
  .pill.ready { color: var(--add-edge); border-color: var(--add-edge); background: var(--add-bg); }
  .pill.failed { color: var(--del-edge); border-color: var(--del-edge); background: var(--del-bg); }
  .pill.building, .pill.queued { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
  .dot { display: inline-block; width: 0.45rem; height: 0.45rem; border-radius: 50%;
         background: var(--add-edge); }
  .forget { padding: 0.2rem 0.55rem; cursor: pointer; border: 1px solid var(--line-c);
            border-radius: 6px; background: var(--panel); color: var(--ink-faint); font: inherit;
            font-size: 0.78rem; }
  .forget:hover { color: var(--del-edge); border-color: var(--del-edge); }
  .empty { margin-top: 1.5rem; padding: 1.5rem; border: 1px dashed var(--line-c);
           border-radius: 8px; color: var(--ink-soft); }
  .empty code, .hint code { font-family: var(--mono); color: var(--ink); }
  .hint { margin-top: 1.5rem; color: var(--ink-faint); font-size: 0.85rem; }
  .building-page { max-width: 44rem; }
  .building-page .log { margin-top: 1rem; padding: 0.9rem; border: 1px solid var(--line-c);
                        border-radius: 8px; background: var(--panel); font-family: var(--mono);
                        font-size: 0.8rem; white-space: pre-wrap; color: var(--ink-soft); }
`;

function facts(pr: PrView): string {
  if (pr.state === "ready") {
    return `${pr.slices ?? 0} slices · ${pr.graphs ?? 0} with a walkable call graph`;
  }
  if (pr.state === "failed") return "";
  return "slicing and walking call graphs…";
}

function row(pr: PrView): string {
  const heading =
    pr.state === "ready"
      ? `<a class="title" href="${esc(pr.path)}">${esc(pr.title ?? pr.key)}</a>`
      : `<span class="title">${esc(pr.title ?? pr.key)}</span>`;
  const last = pr.state === "building" ? (pr.log[pr.log.length - 1] ?? "") : "";
  const f = facts(pr);
  return `<div class="row ${pr.state}" data-key="${esc(pr.key)}">
  <div>
    <div class="name"><a href="${esc(pr.prUrl)}">${esc(pr.key)}</a></div>
    ${heading}
    ${f ? `<div class="facts">${esc(f)}</div>` : ""}
    ${pr.error ? `<div class="why">${esc(pr.error)}</div>` : ""}
    ${last ? `<div class="last">${esc(last)}</div>` : ""}
  </div>
  <div class="side-actions">
    ${pr.live ? '<span class="dot" title="language services warm"></span>' : ""}
    <span class="pill ${pr.state}">${pr.state}</span>
    <button class="forget" type="button" title="Drop this PR from the server">forget</button>
  </div>
</div>`;
}

/**
 * Keeps the list current without a reload: the server is the only renderer
 * of rows, so the poll fetches this same page and swaps the parts that
 * change. "Forget" goes to the server, and the next poll shows the result.
 */
const INDEX_JS = `
function poll() {
  fetch("/", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.text() : null; })
    .then(function (html) {
      if (!html) return;
      var doc = new DOMParser().parseFromString(html, "text/html");
      var rows = doc.querySelector(".rows");
      var empty = doc.querySelector(".empty");
      if (rows) document.querySelector(".rows").innerHTML = rows.innerHTML;
      if (empty) document.querySelector(".empty").hidden = empty.hidden;
    })
    .catch(function () { /* server gone; leave the last list up */ });
}
document.addEventListener("click", function (e) {
  var button = e.target.closest(".forget");
  if (!button) return;
  var key = button.closest(".row").dataset.key;
  fetch("/prs/" + encodeURIComponent(key), { method: "DELETE" }).then(poll, poll);
});
setInterval(poll, 2000);
`;

export function renderIndexPage(prs: PrView[], version: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pr-review — ${prs.length} PR${prs.length === 1 ? "" : "s"}</title>
<style>${REPORT_CSS}${INDEX_CSS}</style>
</head>
<body>
<header>
  <h1>Deep Review</h1>
  <div class="meta">One server, every PR you are reading. v${esc(version)}</div>
</header>
<div class="rows">${prs.map(row).join("\n")}</div>
<div class="empty"${prs.length ? " hidden" : ""}>
  Nothing loaded yet. Add a PR from any terminal:
  <div><code>pr-review https://github.com/owner/repo/pull/123</code></div>
</div>
<div class="hint">
  <code>pr-review status</code> lists these from the terminal;
  <code>pr-review stop</code> shuts the server down.
</div>
<script>${INDEX_JS}</script>
</body>
</html>
`;
}

/**
 * What a PR's own URL shows before its build finishes. It watches `/prs`
 * for its own key and reloads into the real explorer the moment it is
 * ready, so a reader can open the link the CLI printed straight away.
 */
export function renderBuildingPage(pr: PrView): string {
  const failed = pr.state === "failed";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pr.key)} — ${failed ? "failed" : "building"}</title>
<style>${REPORT_CSS}${INDEX_CSS}</style>
</head>
<body class="building-page">
<header>
  <h1>${esc(pr.title ?? pr.key)}</h1>
  <div class="meta"><a href="${esc(pr.prUrl)}">${esc(pr.key)}</a> · ${failed ? "build failed" : "slicing and walking call graphs…"}</div>
</header>
${pr.error ? `<div class="why">${esc(pr.error)}</div>` : ""}
<div class="log">${esc(pr.log.join("\n")) || "queued…"}</div>
<div class="hint"><a href="/">← every PR on this server</a></div>
<script>
var KEY = ${JSON.stringify(pr.key)};
setInterval(function () {
  fetch("/prs", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data) return;
      var mine = data.prs.filter(function (p) { return p.key === KEY; })[0];
      if (!mine) { location.href = "/"; return; }
      /* Ready: the same URL now serves the explorer itself. */
      if (mine.state === "ready") { location.reload(); return; }
      var log = document.querySelector(".log");
      if (log && mine.log) log.textContent = mine.log.join("\\n");
    })
    .catch(function () { /* server gone; nothing to show */ });
}, 1500);
</script>
</body>
</html>
`;
}
