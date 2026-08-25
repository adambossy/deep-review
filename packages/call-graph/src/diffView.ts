/**
 * The one way code is rendered in a report: GitHub's unified diff. Head-side
 * source with removed lines interleaved in red, added lines in green,
 * per-word highlights inside a changed pair, and expander bars over what
 * stays hidden. Every panel builds rows with the functions here and renders
 * them with `renderDiffRows`, so a diff looks the same wherever it appears
 * and any overlay (call marks, symbol links, the focused function) sits on
 * top of the same base.
 */

import { diffWordsWithSpace } from "diff";
import {
  escapeHtml as esc,
  renderLine,
  tokenizeLines,
  type Language,
  type Mark,
} from "./highlight.js";
import {
  addedLines,
  deletedLinesByPosition,
  gapRow,
  lineRow,
  staticGapRow,
  type Decorations,
  type FileEntry,
} from "./html.js";
import type { DiffHunk, SourceSegment } from "./types.js";

export type DiffRow =
  | { kind: "ctx"; n: number; text: string }
  | { kind: "add"; n: number; text: string; marks?: Mark[] }
  | { kind: "del"; text: string; marks?: Mark[] }
  /** Hidden head lines `from..to`, expandable when the file is embedded. */
  | { kind: "gap"; from: number; to: number }
  /** A `\ No newline at end of file` marker. */
  | { kind: "meta"; text: string };

export interface LineSpan {
  startLine: number;
  endLine: number;
}

export interface FileDiffOptions {
  /** Lines of unchanged file shown around each change and around `focus`. */
  context: number;
  /** A declaration to keep visible in full, with context, changes or not. */
  focus?: LineSpan | undefined;
}

/**
 * Whole-file unified view: every change with context, the focused span with
 * context, and expandable gaps over the rest. Removed lines sit above the
 * head line they now precede; a deletion at end of file comes last.
 */
export function fileDiffRows(
  lines: readonly string[],
  hunks: DiffHunk[],
  options: FileDiffOptions,
): DiffRow[] {
  const added = addedLines(hunks);
  const deleted = deletedLinesByPosition(hunks);
  const count = lines.length;
  const visible = new Set<number>();
  const show = (from: number, to: number): void => {
    for (let n = Math.max(1, from); n <= Math.min(count, to); n++) visible.add(n);
  };
  for (const n of added) show(n - options.context, n + options.context);
  for (const anchor of deleted.keys()) show(anchor - options.context - 1, anchor + options.context);
  if (options.focus) show(options.focus.startLine - options.context, options.focus.endLine + options.context);

  const rows: DiffRow[] = [];
  let gapFrom: number | null = null;
  const flushGap = (to: number): void => {
    if (gapFrom !== null && to >= gapFrom) rows.push({ kind: "gap", from: gapFrom, to });
    gapFrom = null;
  };
  for (let n = 1; n <= count; n++) {
    if (!visible.has(n)) {
      gapFrom ??= n;
      continue;
    }
    flushGap(n - 1);
    for (const text of deleted.get(n) ?? []) rows.push({ kind: "del", text });
    const text = lines[n - 1] ?? "";
    rows.push(added.has(n) ? { kind: "add", n, text } : { kind: "ctx", n, text });
  }
  flushGap(count);
  for (const text of deleted.get(count + 1) ?? []) rows.push({ kind: "del", text });
  return rows;
}

/** Hunks alone, when the file's text is not on the page: gaps between them are fixed. */
export function hunkRows(hunks: DiffHunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let previousEnd = 0;
  for (const hunk of [...hunks].sort((a, b) => a.newStart - b.newStart)) {
    if (hunk.newStart > previousEnd + 1) rows.push({ kind: "gap", from: previousEnd + 1, to: hunk.newStart - 1 });
    let n = hunk.newStart;
    for (const line of hunk.lines) {
      const text = line.slice(1);
      if (line.startsWith("\\")) rows.push({ kind: "meta", text: line });
      else if (line.startsWith("-")) rows.push({ kind: "del", text });
      else if (line.startsWith("+")) rows.push({ kind: "add", n: n++, text });
      else rows.push({ kind: "ctx", n: n++, text });
    }
    previousEnd = Math.max(previousEnd, n - 1);
  }
  return rows;
}

/** A slice fragment's own diff lines, each still prefixed with its marker. */
export function fragmentRows(lines: readonly string[], newLineNumbers: readonly (number | null)[]): DiffRow[] {
  return lines.map((line, i): DiffRow => {
    const text = line.slice(1);
    const n = newLineNumbers[i];
    if (line.startsWith("\\")) return { kind: "meta", text: line };
    if (line.startsWith("-") || n === null || n === undefined) return { kind: "del", text };
    return line.startsWith("+") ? { kind: "add", n, text } : { kind: "ctx", n, text };
  });
}

/**
 * A function's source segments (when its file is not embedded) as a diff:
 * added lines tinted, removed lines interleaved, omitted stretches as gaps.
 */
export function segmentRows(segments: readonly SourceSegment[], hunks: DiffHunk[]): DiffRow[] {
  const added = addedLines(hunks);
  const deleted = deletedLinesByPosition(hunks);
  const rows: DiffRow[] = [];
  let previousEnd = 0;
  for (const segment of segments) {
    if (previousEnd > 0 && segment.startLine > previousEnd + 1) {
      rows.push({ kind: "gap", from: previousEnd + 1, to: segment.startLine - 1 });
    }
    segment.lines.forEach((text, i) => {
      const n = segment.startLine + i;
      for (const removed of deleted.get(n) ?? []) rows.push({ kind: "del", text: removed });
      rows.push(added.has(n) ? { kind: "add", n, text } : { kind: "ctx", n, text });
    });
    previousEnd = segment.startLine + segment.lines.length - 1;
  }
  for (const removed of deleted.get(previousEnd + 1) ?? []) rows.push({ kind: "del", text: removed });
  return rows;
}

/**
 * GitHub's within-line highlighting: a run of removed lines immediately
 * followed by an equally long run of added lines pairs up 1:1, and the words
 * that differ inside each pair are marked. Runs of different length, or a
 * pair with nothing in common, get no inner marks — the whole line changed.
 */
export function markIntraLine(rows: DiffRow[]): void {
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.kind !== "del") {
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j]!.kind === "del") j++;
    let k = j;
    while (k < rows.length && rows[k]!.kind === "add") k++;
    if (j - i === k - j) {
      for (let p = 0; p < j - i; p++) {
        const del = rows[i + p] as Extract<DiffRow, { kind: "del" }>;
        const add = rows[j + p] as Extract<DiffRow, { kind: "add" }>;
        const marks = intraLineMarks(del.text, add.text);
        if (marks) {
          del.marks = marks.del;
          add.marks = marks.add;
        }
      }
    }
    i = k;
  }
}

function intraLineMarks(before: string, after: string): { del: Mark[]; add: Mark[] } | null {
  const changes = diffWordsWithSpace(before, after);
  // Sharing only whitespace is sharing nothing: the line was rewritten.
  if (!changes.some((c) => !c.added && !c.removed && c.value.trim())) return null;
  const del: Mark[] = [];
  const add: Mark[] = [];
  let b = 0;
  let a = 0;
  for (const change of changes) {
    const len = change.value.length;
    if (change.removed) {
      del.push({ start: b, end: b + len, cls: "diff-del-inner" });
      b += len;
    } else if (change.added) {
      add.push({ start: a, end: a + len, cls: "diff-add-inner" });
      a += len;
    } else {
      b += len;
      a += len;
    }
  }
  return { del, add };
}

export interface DiffRenderOptions {
  width: number;
  lang: Language;
  /** The embedded file behind the rows: pre-highlighted lines, expandable gaps. */
  entry?: FileEntry | undefined;
  /** Row classes and marks keyed by head line (call marks, self-sym, …). */
  decorations?: Decorations | undefined;
  /** Extra marks for a row from its text; the head line is null for a removed row. */
  marksFor?: ((text: string, headLine: number | null) => Mark[]) | undefined;
  /** Head span outlined as the focused declaration. */
  focus?: LineSpan | undefined;
}

/** Render rows to `<span class="line">`s; the caller wraps them in a `<pre>`. */
export function renderDiffRows(rows: readonly DiffRow[], options: DiffRenderOptions): string {
  const { width, lang, entry, decorations, marksFor, focus } = options;
  // Rows without an embedded file are tokenized together so multi-line
  // strings and comments carry across them; removed rows always are, since
  // the embedded file (head side) has no tokens for them.
  const localTokens = tokenizeLines(
    rows.map((r) => (r.kind === "ctx" || r.kind === "add" || r.kind === "del" ? r.text : "")),
    lang,
  );
  const out: string[] = [];
  rows.forEach((row, i) => {
    switch (row.kind) {
      case "gap":
        out.push(entry ? gapRow(entry, row.from, row.to) : staticGapRow(row.to - row.from + 1));
        return;
      case "meta":
        out.push(lineRow("", width, esc(row.text)));
        return;
      case "del": {
        const marks = [...(row.marks ?? []), ...(marksFor?.(row.text, null) ?? [])];
        out.push(lineRow("−", width, renderLine(row.text, localTokens[i]!, marks), ["diff-del"]));
        return;
      }
      default: {
        const deco = decorations?.get(row.n);
        const marks = [
          ...(row.kind === "add" ? row.marks ?? [] : []),
          ...(deco?.marks ?? []),
          ...(marksFor?.(row.text, row.n) ?? []),
        ];
        // The embedded file's pre-rendered line is reusable only when it is
        // this row's text; a row from a stale hunk falls back to its own tokens.
        const fromFile = entry && entry.lines[row.n - 1] === row.text ? entry : undefined;
        const html =
          fromFile && !marks.length
            ? fromFile.html[row.n - 1]!
            : renderLine(row.text, fromFile ? fromFile.tokens[row.n - 1]! : localTokens[i]!, marks);
        const cls = [
          ...(row.kind === "add" ? ["diff-add"] : []),
          ...(deco?.cls ?? []),
          ...(focus && row.n >= focus.startLine && row.n <= focus.endLine ? ["in-focus"] : []),
        ];
        out.push(lineRow(row.n, width, html, cls));
      }
    }
  });
  return out.join("");
}

export function renderDiffBlock(rows: readonly DiffRow[], options: DiffRenderOptions): string {
  return `<pre class="source" data-w="${options.width}">${renderDiffRows(rows, options)}</pre>`;
}

/** Head line the rows start at: the first row's line, or a leading gap's first hidden line. */
export function firstHeadLine(rows: readonly DiffRow[]): number {
  for (const row of rows) {
    if (row.kind === "gap") return row.from;
    if (row.kind === "ctx" || row.kind === "add") return row.n;
  }
  return 1;
}

/** Gutter width for rows: the widest head line number they show. */
export function rowsWidth(rows: readonly DiffRow[], entry?: FileEntry): number {
  if (entry) return String(entry.lines.length).length;
  let max = 1;
  for (const row of rows) {
    if (row.kind === "ctx" || row.kind === "add") max = Math.max(max, row.n);
    else if (row.kind === "gap") max = Math.max(max, row.to);
  }
  return String(max).length;
}
