import type { DiffIndex, IndexedHunk } from "./annotate.js";
import type { Fragment, Slice, SliceReport } from "./types.js";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One PR's report paired with the diff it was produced from. */
export interface RenderEntry {
  report: SliceReport;
  index: DiffIndex;
  /** The worktrees the diff was taken between. */
  baseDir: string;
  headDir: string;
}

const CSS = `
:root {
  color-scheme: light dark;
  font-family: ui-sans-serif, system-ui, sans-serif;
  --add-bg: rgba(46, 160, 67, 0.15);
  --del-bg: rgba(248, 81, 73, 0.15);
  --accent: #0969da;
  --muted: #59636e;
  --rule: rgba(128, 128, 128, 0.28);
  --card: rgba(128, 128, 128, 0.06);
}
@media (prefers-color-scheme: dark) {
  :root { --accent: #58a6ff; --muted: #8b949e; }
}
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 62rem; padding: 1.5rem 1rem 5rem; line-height: 1.5; }
h1 { font-size: 1.4rem; margin: 0 0 0.2rem; }
h2 { font-size: 1.05rem; margin: 0; }
a { color: var(--accent); }
code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.88em; }
.sub { color: var(--muted); font-size: 0.85rem; margin: 0 0 1.5rem; }

.tabs { display: flex; gap: 0.4rem; flex-wrap: wrap; border-bottom: 1px solid var(--rule);
        margin-bottom: 1.5rem; }
.tab { appearance: none; border: none; background: none; cursor: pointer; font: inherit;
       font-size: 0.9rem; padding: 0.5rem 0.8rem; color: var(--muted);
       border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tab[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent);
                             font-weight: 600; }
.pr[hidden] { display: none; }

.meta { background: var(--card); border: 1px solid var(--rule); border-radius: 8px;
        padding: 0.9rem 1.1rem; margin-bottom: 1.5rem; }
.meta h2 { font-size: 1.1rem; margin-bottom: 0.3rem; }
.meta dl { display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.9rem;
           margin: 0.7rem 0 0; font-size: 0.82rem; }
.meta dt { color: var(--muted); }
.meta dd { margin: 0; font-family: ui-monospace, Menlo, monospace; }
.overview { margin: 0.8rem 0 0; font-size: 0.92rem; }

.slice { border: 1px solid var(--rule); border-radius: 8px; margin-bottom: 1rem;
         overflow: hidden; }
.slice-head { display: flex; gap: 0.9rem; padding: 0.9rem 1.1rem; align-items: baseline; }
.rank { font-size: 1.5rem; font-weight: 700; color: var(--accent); line-height: 1;
        min-width: 1.6rem; font-variant-numeric: tabular-nums; }
.slice-body { flex: 1; min-width: 0; }
.slice h3 { margin: 0 0 0.35rem; font-size: 1rem; }
.badges { display: flex; gap: 0.4rem; flex-wrap: wrap; margin: 0.45rem 0 0; }
.badge { font-size: 0.7rem; padding: 0.1rem 0.45rem; border-radius: 4px;
         background: rgba(128, 128, 128, 0.18); color: var(--muted); }
.badge.target { background: rgba(9, 105, 218, 0.14); color: var(--accent);
                font-family: ui-monospace, Menlo, monospace; }
.summary { margin: 0; font-size: 0.9rem; }
.rationale { margin: 0.5rem 0 0; padding-left: 0.7rem; border-left: 2px solid var(--rule);
             color: var(--muted); font-size: 0.85rem; }

details { border-top: 1px solid var(--rule); }
summary { cursor: pointer; padding: 0.5rem 1.1rem; font-size: 0.82rem; color: var(--muted); }
summary:hover { color: var(--accent); }
.frags { padding: 0 1.1rem 1rem; }
.frag { margin-top: 0.9rem; }
.frag-head { display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap;
             font-size: 0.75rem; color: var(--muted); margin-bottom: 0.25rem; }
.frag-id { font-family: ui-monospace, Menlo, monospace; color: var(--accent); }
.frag-sum { font-size: 0.82rem; margin: 0 0 0.35rem; }

pre.diff { overflow-x: auto; background: rgba(128, 128, 128, 0.07);
           border: 1px solid var(--rule); border-radius: 6px; padding: 0.5rem 0;
           margin: 0; line-height: 1.45; font-family: ui-monospace, Menlo, monospace;
           font-size: 0.76rem; }
.diff .line { display: block; padding: 0 0.7rem; white-space: pre; }
.diff .line.add { background: var(--add-bg); }
.diff .line.del { background: var(--del-bg); }
.diff .no { color: var(--muted); user-select: none; }
.diff .hh { color: var(--muted); background: rgba(9, 105, 218, 0.08); }

.legend { color: var(--muted); font-size: 0.78rem; margin-top: 2rem;
          border-top: 1px solid var(--rule); padding-top: 0.8rem; }
`;

const SCRIPT = `
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      document.getElementById(t.dataset.target).hidden = !on;
    });
  });
});
`;

/** The fragment's own lines, with both line numbers and diff tinting. */
function renderFragment(fragment: Fragment, hunk: IndexedHunk): string {
  const width = String(hunk.lines.length).length;
  const rows: string[] = [
    `<span class="line hh"><span class="no">${" ".repeat(width)}      </span> ${esc(hunk.header)}</span>`,
  ];
  for (let n = fragment.startLine; n <= fragment.endLine; n++) {
    const raw = hunk.lines[n - 1];
    if (raw === undefined) continue;
    const kind = raw.startsWith("+") ? "add" : raw.startsWith("-") ? "del" : "";
    const fileNo = String(hunk.newLineNumbers[n - 1] ?? "").padStart(6);
    rows.push(
      `<span class="line ${kind}"><span class="no">${String(n).padStart(width)} ${fileNo}</span> ${esc(raw)}</span>`,
    );
  }
  return [
    `<div class="frag">`,
    `<div class="frag-head"><span class="frag-id">${esc(fragment.id)}</span><span>${esc(fragment.file)}</span></div>`,
    `<p class="frag-sum">${esc(fragment.summary)}</p>`,
    `<pre class="diff">${rows.join("\n")}</pre>`,
    `</div>`,
  ].join("");
}

function renderSlice(slice: Slice, rank: number, index: DiffIndex): string {
  const lines = slice.fragments.reduce(
    (n, f) => n + (f.endLine - f.startLine + 1),
    0,
  );
  const files = new Set(slice.fragments.map((f) => f.file));
  const badges = [
    `<span class="badge">${slice.fragments.length} fragment${slice.fragments.length === 1 ? "" : "s"}</span>`,
    `<span class="badge">~${lines} lines</span>`,
    `<span class="badge">${files.size} file${files.size === 1 ? "" : "s"}</span>`,
    ...(slice.target
      ? [
          `<span class="badge target">target: ${esc(slice.target.name)} — ${esc(slice.target.file)}</span>`,
        ]
      : []),
  ].join("");

  const fragments = slice.fragments
    .map((f) => {
      const hunk = index.byId.get(f.hunkId);
      return hunk ? renderFragment(f, hunk) : "";
    })
    .join("");

  return [
    `<section class="slice">`,
    `<div class="slice-head">`,
    `<div class="rank">${rank}</div>`,
    `<div class="slice-body">`,
    `<h3>${esc(slice.title)}</h3>`,
    `<p class="summary">${esc(slice.summary)}</p>`,
    `<p class="rationale">${esc(slice.rationale)}</p>`,
    `<div class="badges">${badges}</div>`,
    `</div></div>`,
    `<details${rank <= 2 ? " open" : ""}>`,
    `<summary>Show the ${slice.fragments.length} fragment${slice.fragments.length === 1 ? "" : "s"}</summary>`,
    `<div class="frags">${fragments}</div>`,
    `</details>`,
    `</section>`,
  ].join("");
}

function renderPr(entry: RenderEntry, i: number, many: boolean): string {
  const { report, index } = entry;
  const { pr } = report;
  const fragments = report.slices.reduce((n, s) => n + s.fragments.length, 0);
  const tickets =
    report.tickets.length > 0
      ? report.tickets
          .map((t) => `<a href="${esc(t.url)}">${esc(t.identifier)}</a>`)
          .join(", ")
      : "none";

  return [
    `<div class="pr" id="pr-${i}"${!many || i === 0 ? "" : " hidden"}>`,
    `<div class="meta">`,
    `<h2><a href="${esc(pr.url)}">${esc(pr.owner)}/${esc(pr.repo)}#${pr.number}</a> — ${esc(pr.title)}</h2>`,
    `<dl>`,
    `<dt>Slices</dt><dd>${report.slices.length}, ${fragments} fragments over ${index.hunks.length} hunks</dd>`,
    `<dt>Changed lines</dt><dd>${index.changedLineCount}</dd>`,
    `<dt>Range</dt><dd>${esc(pr.mergeBaseSha.slice(0, 8))}..${esc(pr.headSha.slice(0, 8))} (merge base to head)</dd>`,
    `<dt>Tickets</dt><dd>${tickets}</dd>`,
    `<dt>Model</dt><dd>${esc(report.model)}</dd>`,
    `</dl>`,
    `<p class="overview">${esc(report.overview)}</p>`,
    `</div>`,
    report.slices.map((s, n) => renderSlice(s, n + 1, index)).join(""),
    `</div>`,
  ].join("");
}

/**
 * Render one or more slice reports as a standalone page: each PR's slices in
 * priority order, every fragment showing the diff lines it actually claims.
 */
export function renderSliceReportsHtml(entries: RenderEntry[]): string {
  const many = entries.length > 1;
  const tabs = many
    ? `<div class="tabs" role="tablist">${entries
        .map(
          (e, i) =>
            `<button class="tab" role="tab" data-target="pr-${i}" aria-selected="${i === 0}">#${e.report.pr.number} — ${esc(e.report.pr.title.slice(0, 44))}${e.report.pr.title.length > 44 ? "…" : ""}</button>`,
        )
        .join("")}</div>`
    : "";

  const title = many
    ? `PR slices — ${entries.map((e) => `#${e.report.pr.number}`).join(", ")}`
    : `PR slices — #${entries[0]?.report.pr.number ?? ""}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style></head>
<body>
<header>
  <h1>${esc(title)}</h1>
  <p class="sub">Each PR's changes grouped into slices, ordered from most to least central to
  the PR's purpose. Every added and removed line belongs to exactly one fragment of exactly
  one slice.</p>
</header>
${tabs}
${entries.map((e, i) => renderPr(e, i, many)).join("")}
<p class="legend">Fragment ids read <code>path#hunk@start-end</code>. In each diff block the
left column is the hunk-local line number the slice cites; the right is the line's position
in the file at the PR's head, blank for removed lines.</p>
<script>${SCRIPT}</script>
</body></html>
`;
}
