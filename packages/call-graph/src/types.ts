export type { DiffHunk, FileDiff } from "@deep-review/pr";

import type { DiffHunk } from "@deep-review/pr";

export interface CallSite {
  /** 1-based line in the file that contains the call. */
  line: number;
  snippet: string;
  /** 0-based character range of the call expression within the line. */
  startColumn?: number;
  endColumn?: number;
}

/** A named declaration's extent — used for symbol breadcrumbs. */
export interface SymbolRange {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  /**
   * Exact position of the declared name (1-based line, 0-based columns).
   * Optional: hand-built fixtures and files embedded without a language
   * service carry ranges only.
   */
  nameLine?: number;
  nameColumn?: number;
  nameEndColumn?: number;
  /** Declarations nested inside this one: a class's methods, an inner function. */
  children?: SymbolRange[];
}

/** Session-local id of a definition site (`d1`, `d2`, …), handed out as symbols are clicked. */
export type DefinitionId = string;

/** Where a symbol is declared, plus what a panel showing it needs. */
export interface DefinitionTarget {
  id: DefinitionId;
  name: string;
  /** Language-service kind: "function", "class", "variable", "parameter", … */
  kind: string;
  /** Repo-relative path, or the absolute path when `external`. */
  file: string;
  external: boolean;
  nameLine: number;
  nameColumn: number;
  nameEndColumn: number;
  /** Full declaration extent, for the synthesized panel. */
  startLine: number;
  endLine: number;
  /** When this definition is a call-graph node's declaration, that node's id — its panel already exists. */
  nodeId?: string;
  /**
   * Source window for a definition whose file the page does not embed
   * whole (external, or a repo file nothing else on the page shows).
   * Definitions in embedded files read from the file instead.
   */
  source?: SourceSegment;
}

/** One place a definition is called from (or, for non-callables, referenced). */
export interface ReferenceSite {
  /** Repo-relative head-side file. */
  file: string;
  line: number;
  startColumn: number;
  endColumn: number;
  snippet: string;
  /** Name of the function (or class) the site sits in; the file's basename at module level. */
  enclosingName: string;
  /**
   * Panel to open for this site — the enclosing declaration's graph-node or
   * synthesized panel. Absent for a site at module level.
   */
  panelId?: string;
  /**
   * On a "calls" list: the function is used here without being called —
   * passed as a value to `functools.partial`, `map`, a callback slot. Call
   * hierarchy does not see these, so they come from the reference search.
   */
  indirect?: true;
}

/** Every place a definition is used, for the callers menu. */
export interface ReferenceList {
  /** "calls" from call hierarchy; "references" when the symbol is not callable. */
  kind: "calls" | "references";
  sites: ReferenceSite[];
}

/**
 * Full content of a file that the HTML report may need beyond the initially
 * visible ranges (for "expand context" widgets): the target's and callers'
 * files on each side of the PR.
 */
export interface EmbeddedFile {
  side: "before" | "after";
  path: string;
  lines: string[];
  symbols: SymbolRange[];
}

/** A contiguous run of source lines starting at a 1-based line number. */
export interface SourceSegment {
  startLine: number;
  lines: string[];
}

/** What we know about a function on one side (base or head) of the PR. */
export interface FunctionSnapshot {
  /** Repo-relative path in that revision. */
  file: string;
  /** 1-based line where the function starts. */
  startLine: number;
  /** 1-based line where the function ends. */
  endLine: number;
  callSites: CallSite[];
  /**
   * The function's source. Usually one segment covering the whole body;
   * for large callers, context windows around each call site instead.
   */
  source: SourceSegment[];
  /** True when `source` elides part of the function. */
  truncated: boolean;
}

/** A caller or callee of the target function. */
export interface RelatedFunction {
  name: string;
  /** Repo-relative path (head side when present in both revisions). */
  file: string;
  presence: "before" | "after" | "both";
  before: FunctionSnapshot | null;
  after: FunctionSnapshot | null;
  /** PR diff hunks that overlap this function's body on either side. */
  hunks: DiffHunk[];
  changedInPr: boolean;
  /** When the PR renamed the function, its name before the PR. */
  renamedFrom?: string;
}

export interface TargetFunction {
  name: string;
  before: FunctionSnapshot | null;
  after: FunctionSnapshot | null;
  hunks: DiffHunk[];
  changedInPr: boolean;
  /** When the PR renamed the function, its name before the PR. */
  renamedFrom?: string;
}

export interface CallGraphResult {
  prUrl: string;
  prTitle: string;
  functionName: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  target: TargetFunction;
  callers: RelatedFunction[];
  callees: RelatedFunction[];
  files: EmbeddedFile[];
}

/** One function in a recursively-walked call graph. */
export interface PathNode {
  /** Stable id: `<file>#<name>`. */
  id: string;
  name: string;
  file: string;
  presence: "before" | "after" | "both";
  before: FunctionSnapshot | null;
  after: FunctionSnapshot | null;
  hunks: DiffHunk[];
  changedInPr: boolean;
  /** When the PR renamed the function, its name before the PR. */
  renamedFrom?: string;
  /** False for boundary functions whose callers/callees were not walked. */
  expanded: boolean;
  /**
   * Exact position of the declared name in the preferred (after, else
   * before) revision: 1-based line, 0-based column.
   */
  nameLine: number;
  nameColumn: number;
}

/** A caller→callee relationship; call sites live in the caller's source. */
export interface PathEdge {
  from: string;
  to: string;
  before: CallSite[];
  after: CallSite[];
}

/** Result of recursively walking the call graph out from one function. */
export interface CallPathResult {
  prUrl: string;
  prTitle: string;
  functionName: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  rootId: string;
  nodes: PathNode[];
  edges: PathEdge[];
  files: EmbeddedFile[];
}
