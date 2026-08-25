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
}

/**
 * Page-local id of a definition site (`d1`, `d2`, …). Short on purpose: it
 * is repeated in every link mark's attributes, thousands of times a page.
 */
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
  /**
   * Whether the page can open this definition: a call-graph node's panel
   * (`nodeId`) or a synthesized one. False when the panel budget ran out —
   * links still carry the id so an on-screen declaration lights up in place.
   */
  panel: boolean;
  /** When this definition is a call-graph node's declaration, that node's id — its panel already exists. */
  nodeId?: string;
  /**
   * Source window for a definition whose file the page does not embed
   * whole (external, or a repo file nothing else on the page shows).
   * Definitions in embedded files read from the file instead.
   */
  source?: SourceSegment;
}

/** One occurrence of a symbol on a head-side line, resolved to its definition. */
export interface SymbolLink {
  /** 1-based head-side line. */
  line: number;
  /** 0-based column range of the identifier. */
  start: number;
  end: number;
  def: DefinitionId;
}

/**
 * Everything the page needs to open any symbol's definition without a
 * server: per-file links and the definitions they point at.
 */
export interface NavigationData {
  links: Record<string, SymbolLink[]>;
  definitions: Record<DefinitionId, DefinitionTarget>;
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
