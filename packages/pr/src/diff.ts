import type { DiffHunk, FileDiff } from "./types.js";

const FILE_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse `git diff` output into per-file hunks. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let hunk: DiffHunk | null = null;

  for (const line of text.split("\n")) {
    const fileMatch = FILE_HEADER.exec(line);
    if (fileMatch) {
      current = { oldPath: fileMatch[1]!, newPath: fileMatch[2]!, hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    if (!current) continue;

    if (line.startsWith("--- ")) {
      if (line === "--- /dev/null") current.oldPath = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (line === "+++ /dev/null") current.newPath = null;
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      hunk = {
        header: line,
        oldStart: Number(hunkMatch[1]!),
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]!),
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }

    if (hunk && /^[ +\-\\]/.test(line)) {
      hunk.lines.push(line);
    }
  }

  return files;
}

/**
 * Hunks whose base-side ("old") or head-side ("new") range overlaps the
 * given 1-based line range. A zero-length side (pure insertion/deletion)
 * is treated as touching the line it sits on.
 */
export function hunksOverlapping(
  file: FileDiff,
  side: "old" | "new",
  startLine: number,
  endLine: number,
): DiffHunk[] {
  return file.hunks.filter((h) => {
    const start = side === "old" ? h.oldStart : h.newStart;
    const length = side === "old" ? h.oldLines : h.newLines;
    const end = start + Math.max(length, 1) - 1;
    return start <= endLine && end >= startLine;
  });
}

/** Hunks overlapping a line range of one file on one side of the diff. */
export function hunksForFileRange(
  files: FileDiff[],
  side: "old" | "new",
  path: string,
  startLine: number,
  endLine: number,
): DiffHunk[] {
  const pathKey = side === "old" ? "oldPath" : "newPath";
  const file = files.find((f) => f[pathKey] === path);
  return file ? hunksOverlapping(file, side, startLine, endLine) : [];
}

/** Paths touched by the diff, on both sides. */
export function changedPaths(files: FileDiff[]): Set<string> {
  const paths = new Set<string>();
  for (const f of files) {
    if (f.oldPath) paths.add(f.oldPath);
    if (f.newPath) paths.add(f.newPath);
  }
  return paths;
}
