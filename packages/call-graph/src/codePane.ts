/**
 * The one way a panel shows code: a sticky scope header over a unified diff.
 * Function panels, definition panels, and the slice panel's file blocks all
 * render through here, so a pane looks and behaves the same wherever it sits
 * — the header names the file and the declaration the first visible line is
 * in (kept in step with scrolling by `SCOPE_JS`), and the body is the diff
 * rows the caller built with `diffView`.
 */

import {
  firstHeadLine,
  renderDiffRows,
  rowsWidth,
  type DiffRow,
  type LineSpan,
} from "./diffView.js";
import { escapeHtml as esc, type Language, type Mark } from "./highlight.js";
import { scopeLabelFor, type Decorations, type FileEntry } from "./html.js";

export interface CodePaneInput {
  /** Path shown in the header: repo-relative, or a basename for an external file. */
  file: string;
  /** The embedded head-side file, when the page has it: enables expanders and the scope label. */
  entry: FileEntry | undefined;
  rows: readonly DiffRow[];
  lang: Language;
  /** Row classes and marks keyed by head line (call marks, self-sym, …). */
  decorations?: Decorations | undefined;
  /** Extra marks for a row from its text; the head line is null for a removed row. */
  marksFor?: ((text: string, headLine: number | null) => Mark[]) | undefined;
  /** Head span outlined as the focused declaration. */
  focus?: LineSpan | undefined;
  /** Debug builds: explain every identifier's marking (or lack of one). */
  debug?: boolean | undefined;
}

/** "packages/x/retry.ts" → dimmed directory, bold basename. */
function pathHtml(file: string): string {
  const cut = file.lastIndexOf("/") + 1;
  return `${cut > 0 ? `<span class="dir">${esc(file.slice(0, cut))}</span>` : ""}<span class="name">${esc(file.slice(cut))}</span>`;
}

/** "+3 −1" when the rows change anything; nothing when they do not. */
function statHtml(rows: readonly DiffRow[]): string {
  let adds = 0;
  let dels = 0;
  for (const row of rows) {
    if (row.kind === "add") adds++;
    else if (row.kind === "del") dels++;
  }
  if (!adds && !dels) return "";
  return `<span class="stat">${adds ? `<span class="plus">+${adds}</span>` : ""}${
    dels ? `<span class="minus">−${dels}</span>` : ""
  }</span>`;
}

export function renderCodePane(input: CodePaneInput): string {
  const { file, entry, rows } = input;
  const width = rowsWidth(rows, entry);
  const label = entry ? esc(scopeLabelFor(entry.symbols, firstHeadLine(rows))) : "";
  const body = renderDiffRows(rows, {
    width,
    lang: input.lang,
    entry,
    decorations: input.decorations,
    marksFor: input.marksFor,
    focus: input.focus,
    debug: input.debug,
  });
  return `<div class="code-pane"><div class="scope-bar"${entry ? ` data-key="${esc(entry.key)}"` : ""}><span class="scope-path">${pathHtml(
    file,
  )}</span><span class="scope-sym">${label}</span>${statHtml(rows)}</div><pre class="source" data-w="${width}">${body}</pre></div>`;
}
