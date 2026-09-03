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

/** Where the symbol at a position is declared. */
export interface DefinitionLocation {
  /** Absolute path of the declaring file. */
  fileName: string;
  name: string;
  /** Language-service kind: "function", "class", "variable", "parameter", … */
  kind: string;
  /** True when the declaration lies outside the checkout (dependency, stdlib). */
  external: boolean;
  /**
   * True when the position asked about is this declaration's own name:
   * nothing to navigate to, but still the symbol whose callers to list.
   */
  self: boolean;
  /** Position of the declared name: 1-based line, 0-based columns. */
  nameLine: number;
  nameColumn: number;
  nameEndColumn: number;
  /** Full declaration extent, 1-based inclusive. */
  startLine: number;
  endLine: number;
}

/** The declaration a reference sits inside: a function/method, or failing that a class. */
export interface EnclosingDeclaration extends DeclRef {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

/** One place a symbol is called from or referenced. */
export interface IncomingReference {
  fileName: string;
  line: number;
  startColumn: number;
  endColumn: number;
  snippet: string;
  /** Null at module level. */
  enclosing: EnclosingDeclaration | null;
}

/**
 * A language service the analysis can drive: the in-process TypeScript
 * service, or any LSP server that supports call hierarchy.
 */
/**
 * Where a language service is in its life: not started yet (`idle`), spawning
 * and initializing (`starting`), answering (`ready`), or gone — the process
 * exited or never came up (`failed`). A failed service is restarted by the
 * next question asked of it, so `failed` is what a reader sees between the
 * crash and the next click, not a terminal state.
 */
export type ServiceState = "idle" | "starting" | "ready" | "failed";

export interface LanguageBackend {
  readonly rootDir: string;
  /** Where this service is right now; never starts it. */
  status(): ServiceState;
  /** Locate a function declaration by name; prefer one in `preferred` files. */
  findFunction(name: string, preferred: ReadonlySet<string>): Promise<DeclRef | null>;
  /** Callers and callees of the function declared at `decl`. */
  relationsAt(decl: DeclRef): Promise<FunctionRelations | null>;
  /** Full-source snapshot of the function declared at `decl`. */
  snapshotAt(decl: DeclRef): Promise<FunctionSnapshot | null>;
  /**
   * Full line content + declared symbols of a file: repo-relative, or
   * absolute for a file outside the checkout (an external definition).
   */
  fileInfo(file: string): Promise<{ lines: string[]; symbols: SymbolRange[] } | null>;
  /**
   * Where the symbol at `ref` is declared; null when there is none. When
   * `ref` is the declaration itself the answer is that declaration, flagged
   * `self`.
   */
  definitionAt(ref: DeclRef): Promise<DefinitionLocation | null>;
  /**
   * Call sites of the callable declared at `ref`, via call hierarchy. Null
   * when `ref` is not callable — the caller falls back to `referencesAt`.
   */
  incomingCallsAt(ref: DeclRef): Promise<IncomingReference[] | null>;
  /**
   * Every use of the symbol declared at `ref`, excluding the declaration and
   * the import/export bindings that only bring the name into scope. For a
   * callable this is a superset of `incomingCallsAt`: it also finds the
   * places the function is passed as a value rather than called.
   */
  referencesAt(ref: DeclRef): Promise<IncomingReference[]>;
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
