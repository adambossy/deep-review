/** One `@@ -a,b +c,d @@` hunk from a unified diff. */
export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw hunk body lines, each prefixed with " ", "+", "-", or "\". */
  lines: string[];
}

export interface FileDiff {
  /** Path on the base side, or null for added files. */
  oldPath: string | null;
  /** Path on the head side, or null for deleted files. */
  newPath: string | null;
  hunks: DiffHunk[];
}

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
}

export interface TargetFunction {
  name: string;
  before: FunctionSnapshot | null;
  after: FunctionSnapshot | null;
  hunks: DiffHunk[];
  changedInPr: boolean;
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
