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
  identifiersOf,
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

/** The part of a slice fragment the diff view needs: where it sits and what it says. */
export interface FragmentSpan {
  /** Raw diff lines, each still prefixed with " ", "+", "-", or "\\". */
  lines: string[];
  /** Head-side file line per entry of `lines`; null for removed lines. */
  newLineNumbers: (number | null)[];
  /** Head-side extent; a deletion-only fragment has `headEnd === headStart - 1`. */
  headStart: number;
  headEnd: number;
}

/** Lines of the head-side file shown either side of a fragment. */
export const FRAGMENT_CONTEXT = 5;

/**
 * The head-side line ranges a file's fragments show: each fragment padded
 * with context, overlapping or touching pads merged. Shared with the
 * navigation resolver so it asks about exactly the lines that render. A
 * deletion-only fragment (empty head extent) still earns context around the
 * point it sits at.
 */
export function fileBlockRanges(
  fragments: readonly FragmentSpan[],
  lineCount: number,
  context: number = FRAGMENT_CONTEXT,
): Array<[number, number]> {
  const ordered = [...fragments].sort(
    (a, b) => a.headStart - b.headStart || a.headEnd - b.headEnd,
  );
  const ranges: Array<[number, number]> = [];
  for (const fragment of ordered) {
    const from = Math.max(1, fragment.headStart - context);
    const to = Math.min(lineCount, Math.max(fragment.headEnd, fragment.headStart - 1) + context);
    if (to < from) continue;
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  return ranges;
}

/**
 * Every fragment a slice has in one file, as one continuous stretch of that
 * file: each fragment's own rows surrounded by real context, the runs
 * between them as gaps. Without the file's text there is no context to show
 * and nothing to expand into, so the fragments stand alone with fixed gaps
 * between them. Nothing is interleaved between fragments — no ids, no
 * summaries — the tinting already says which lines changed.
 */
export function fragmentDiffRows(
  lines: readonly string[] | undefined,
  fragments: readonly FragmentSpan[],
  context: number = FRAGMENT_CONTEXT,
): DiffRow[] {
  const ordered = [...fragments].sort(
    (a, b) => a.headStart - b.headStart || a.headEnd - b.headEnd,
  );
  const rows: DiffRow[] = [];

  if (!lines) {
    let previousEnd = 0;
    for (const fragment of ordered) {
      if (previousEnd > 0 && fragment.headStart > previousEnd + 1) {
        rows.push({ kind: "gap", from: previousEnd + 1, to: fragment.headStart - 1 });
      }
      rows.push(...fragmentRows(fragment.lines, fragment.newLineNumbers));
      previousEnd = Math.max(previousEnd, fragment.headEnd);
    }
    markIntraLine(rows);
    return rows;
  }

  // Walk the visible ranges; within each, a fragment's own rows stand in
  // for the head lines it covers (a deletion-only fragment covers none, so
  // its rows go in just before the line it sits at).
  let cursor = 0;
  let next = 0;
  for (const [from, to] of fileBlockRanges(ordered, lines.length, context)) {
    if (from > cursor + 1) rows.push({ kind: "gap", from: cursor + 1, to: from - 1 });
    let n = from;
    while (n <= to) {
      const fragment = ordered[next];
      if (fragment && fragment.headStart === n) {
        rows.push(...fragmentRows(fragment.lines, fragment.newLineNumbers));
        next++;
        n = Math.max(n, fragment.headEnd + 1);
        continue;
      }
      rows.push({ kind: "ctx", n, text: lines[n - 1] ?? "" });
      n++;
    }
    cursor = to;
  }
  if (cursor < lines.length) rows.push({ kind: "gap", from: cursor + 1, to: lines.length });
  markIntraLine(rows);
  return rows;
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
 * GitHub's within-line highlighting: a run of removed lines is paired up
 * with the run of added lines that follows it, and the words that differ
 * inside each pair are marked. Equal-length runs pair by position, the way
 * GitHub does; runs of different length — one line rewritten as a paragraph,
 * say — pair by how much the lines share, so the one line that really was
 * edited still gets marked.
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
    const dels = rows.slice(i, j) as Array<Extract<DiffRow, { kind: "del" }>>;
    const adds = rows.slice(j, k) as Array<Extract<DiffRow, { kind: "add" }>>;
    for (const [d, a] of pairLines(dels.map((r) => r.text), adds.map((r) => r.text))) {
      const del = dels[d]!;
      const add = adds[a]!;
      const marks = intraLineMarks(del.text, add.text);
      if (marks) {
        del.marks = marks.del;
        add.marks = marks.add;
      }
    }
    i = k;
  }
}

/**
 * Below this shared fraction, two lines of an uneven run are different lines
 * rather than an edit of one. Only uneven runs are judged: within an even
 * run, position already says which line became which.
 */
const MIN_SIMILARITY = 0.25;

/** Word-diffing every candidate pair is quadratic; past this a run pairs by position or not at all. */
const MAX_PAIRS = 400;

/**
 * Which removed line became which added line: position when the runs match
 * in length, otherwise the non-crossing pairing that shares the most words
 * overall, ignoring pairs too dissimilar to be an edit. Returned as
 * `[removed index, added index]` in top-to-bottom order.
 */
function pairLines(dels: readonly string[], adds: readonly string[]): Array<[number, number]> {
  const m = dels.length;
  const n = adds.length;
  if (!m || !n) return [];
  if (m === n || m * n > MAX_PAIRS) {
    return m === n ? dels.map((_, p): [number, number] => [p, p]) : [];
  }

  const shared = dels.map((del) => adds.map((add) => similarity(del, add)));
  // best[d][a]: the most words the first d removed and first a added lines
  // can share. Skipping a line on either side is always allowed, so a run
  // of one against a run of three still finds its one real pair.
  const best: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let d = 1; d <= m; d++) {
    for (let a = 1; a <= n; a++) {
      const pair = shared[d - 1]![a - 1]!;
      best[d]![a] = Math.max(
        best[d - 1]![a]!,
        best[d]![a - 1]!,
        pair >= MIN_SIMILARITY ? best[d - 1]![a - 1]! + pair : 0,
      );
    }
  }
  const pairs: Array<[number, number]> = [];
  let d = m;
  let a = n;
  while (d > 0 && a > 0) {
    const pair = shared[d - 1]![a - 1]!;
    if (pair >= MIN_SIMILARITY && best[d]![a] === best[d - 1]![a - 1]! + pair) {
      pairs.push([d - 1, a - 1]);
      d--;
      a--;
    } else if (best[d - 1]![a]! >= best[d]![a - 1]!) d--;
    else a--;
  }
  return pairs.reverse();
}

/** Words two lines share, as a fraction of the wordier one. Whitespace counts for nothing. */
function similarity(before: string, after: string): number {
  const total = Math.max(weight(before), weight(after));
  if (!total) return 0;
  let common = 0;
  for (const change of diffWordsWithSpace(before, after)) {
    if (!change.added && !change.removed) common += weight(change.value);
  }
  return common / total;
}

function weight(text: string): number {
  return text.replace(/\s+/g, "").length;
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
  return { del: joinAcrossSpaces(del, before), add: joinAcrossSpaces(add, after) };
}

/**
 * One highlight per changed phrase, not one per changed word: neighbouring
 * marks with nothing but whitespace between them become a single mark, so a
 * rewritten phrase reads as one continuous band instead of a row of boxes.
 */
function joinAcrossSpaces(marks: readonly Mark[], text: string): Mark[] {
  const out: Mark[] = [];
  for (const mark of marks) {
    const last = out[out.length - 1];
    if (last && !text.slice(last.end, mark.start).trim()) last.end = mark.end;
    else out.push({ ...mark });
  }
  return out;
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
  /**
   * Wrap every identifier on a head-side line that no other mark covers in
   * a bare `.id` span, so the page can ask the navigation server about it
   * when it is clicked.
   */
  identifiers?: boolean | undefined;
  /** Debug builds: `.id` spans say they have not been asked about yet. */
  debug?: boolean | undefined;
}

/** Identifier spans over the names of a line that no other mark covers. */
function identifierMarks(text: string, lang: Language, marks: readonly Mark[], debug: boolean): Mark[] {
  const ids = identifiersOf([text], lang)[0] ?? [];
  return ids
    .filter((id) => !marks.some((m) => m.start < id.end && id.start < m.end))
    .map((id) => ({ start: id.start, end: id.end, cls: "id", ...(debug ? { why: "id · not asked yet" } : {}) }));
}

/** Render rows to `<span class="line">`s; the caller wraps them in a `<pre>`. */
export function renderDiffRows(rows: readonly DiffRow[], options: DiffRenderOptions): string {
  const { width, lang, entry, decorations, marksFor, focus, identifiers } = options;
  const debug = options.debug ?? false;
  // Removed lines have no head-side position, so nothing can be asked about them.
  const withIds = (text: string, marks: Mark[]): Mark[] =>
    identifiers ? [...marks, ...identifierMarks(text, lang, marks, debug)] : marks;
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
        const marks = withIds(row.text, [
          ...(row.kind === "add" ? row.marks ?? [] : []),
          ...(deco?.marks ?? []),
          ...(marksFor?.(row.text, row.n) ?? []),
        ]);
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
  return `<pre class="source" data-w="${options.width}"><span class="lines">${renderDiffRows(rows, options)}</span></pre>`;
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
