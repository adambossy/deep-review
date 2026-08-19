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
