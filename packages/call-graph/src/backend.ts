import type { CallSite, FunctionSnapshot, SourceSegment, SymbolRange } from "./types.js";

/** A precise reference to a declared name: 1-based line, 0-based column. */
export interface DeclRef {
  fileName: string;
  line: number;
  column: number;
}

export interface RelationEntry {
  name: string;
  snapshot: FunctionSnapshot;
  decl: DeclRef;
}

export interface FunctionRelations {
  targetName: string;
  target: FunctionSnapshot;
  callers: RelationEntry[];
  callees: RelationEntry[];
}

/**
 * A language service the analysis can drive: the in-process TypeScript
 * service, or any LSP server that supports call hierarchy.
 */
export interface LanguageBackend {
  readonly rootDir: string;
  /** Locate a function declaration by name; prefer one in `preferred` files. */
  findFunction(name: string, preferred: ReadonlySet<string>): Promise<DeclRef | null>;
  /** Callers and callees of the function declared at `decl`. */
  relationsAt(decl: DeclRef): Promise<FunctionRelations | null>;
  /** Full-source snapshot of the function declared at `decl`. */
  snapshotAt(decl: DeclRef): Promise<FunctionSnapshot | null>;
  /** Full line content + declared symbols of a repo-relative file. */
  fileInfo(relativePath: string): Promise<{ lines: string[]; symbols: SymbolRange[] } | null>;
  dispose(): void;
}

/** Functions longer than this are elided to context windows (callers only). */
export const LARGE_FUNCTION_LINES = 60;
/** Context shown on each side of a call site when eliding, like `diff -U10`. */
export const CONTEXT_LINES = 10;

/** Build a snapshot's source segments from full file lines. */
export function extractSource(
  allLines: readonly string[],
  startLine: number,
  endLine: number,
  callSites: CallSite[],
  mode: "full" | "contextIfLarge",
): { source: SourceSegment[]; truncated: boolean } {
  const segment = (from: number, to: number): SourceSegment => ({
    startLine: from,
    lines: allLines.slice(from - 1, to),
  });

  const totalLines = endLine - startLine + 1;
  if (
    mode === "full" ||
    totalLines <= LARGE_FUNCTION_LINES ||
    callSites.length === 0
  ) {
    return { source: [segment(startLine, endLine)], truncated: false };
  }

  // The signature line, plus a window around each call site; overlapping or
  // adjacent windows merge into one segment.
  const windows: Array<[number, number]> = [
    [startLine, startLine],
    ...callSites.map((site): [number, number] => [
      Math.max(startLine, site.line - CONTEXT_LINES),
      Math.min(endLine, site.line + CONTEXT_LINES),
    ]),
  ];
  windows.sort((a, b) => a[0] - b[0]);

  const merged: Array<[number, number]> = [];
  for (const [from, to] of windows) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }

  const covered = merged.reduce((n, [from, to]) => n + (to - from + 1), 0);
  return {
    source: merged.map(([from, to]) => segment(from, to)),
    truncated: covered < totalLines,
  };
}

/** Build deduped call sites (one per line) from line/column ranges. */
export function callSitesFromRanges(
  lines: readonly string[],
  ranges: ReadonlyArray<{
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }>,
): CallSite[] {
  const seen = new Set<number>();
  const sites: CallSite[] = [];
  for (const range of ranges) {
    if (seen.has(range.startLine)) continue;
    seen.add(range.startLine);
    const text = lines[range.startLine - 1] ?? "";
    sites.push({
      line: range.startLine,
      snippet: text.trim(),
      startColumn: range.startColumn,
      endColumn: range.endLine === range.startLine ? range.endColumn : text.length,
    });
  }
  return sites;
}
