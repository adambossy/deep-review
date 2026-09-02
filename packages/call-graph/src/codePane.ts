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
import { escapeHtml as esc, type Language } from "./highlight.js";
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
  /** Head span outlined as the focused declaration. */
  focus?: LineSpan | undefined;
  /**
   * Make the pane answerable: it says which file (by default `file`) and
   * side it shows, so a click on one of its `.id` spans can be turned into
   * a position the navigation server understands.
   */
  navigable?: { side: "before" | "after"; file?: string } | undefined;
  /** Debug builds: explain every mark (`data-why`). */
  debug?: boolean | undefined;
}

const MARKDOWN_FILE = /\.mdx?$/i;

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
  const { file, entry, rows, navigable } = input;
  const width = rowsWidth(rows, entry);
  const label = entry ? esc(scopeLabelFor(entry.symbols, firstHeadLine(rows))) : "";
  const body = renderDiffRows(rows, {
    width,
    lang: input.lang,
    entry,
    decorations: input.decorations,
    focus: input.focus,
    debug: input.debug,
  });
  const paneAttrs = navigable
    ? ` data-file="${esc(navigable.file ?? file)}" data-side="${navigable.side}"`
    : "";
  // Code wraps only for prose (markdown): a code line's indentation and
  // column alignment are meaningful, so it keeps its horizontal scroll.
  const wrap = MARKDOWN_FILE.test(file);
  const preAttrs = wrap ? ` data-w="${width}" style="--gutter:${width}"` : ` data-w="${width}"`;
  return `<div class="code-pane"${paneAttrs}><div class="scope-bar"${entry ? ` data-key="${esc(entry.key)}"` : ""}><span class="scope-path">${pathHtml(
    file,
  )}</span><span class="scope-sym">${label}</span>${statHtml(rows)}</div><pre class="source${wrap ? " wrap" : ""}"${preAttrs}><span class="lines">${body}</span></pre></div>`;
}
