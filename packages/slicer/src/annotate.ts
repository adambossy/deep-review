import type { FileDiff } from "@deep-review/pr";
import type { HunkId } from "./types.js";

/** One hunk with the line numbering the model addresses fragments by. */
export interface IndexedHunk {
  id: HunkId;
  /** Head-side path, or the base-side path when the file was deleted. */
  file: string;
  oldPath: string | null;
  newPath: string | null;
  header: string;
  /** Hunk body lines; body line N is `lines[N - 1]`. */
  lines: string[];
  /** Body line numbers holding an addition or a deletion. */
  changedLines: number[];
  /** Head-side file line number per body line, or null for deletions. */
  newLineNumbers: (number | null)[];
}

export interface DiffIndex {
  hunks: IndexedHunk[];
  byId: Map<HunkId, IndexedHunk>;
  /** Total addition + deletion lines across the diff. */
  changedLineCount: number;
}

function isChanged(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-");
}

/**
 * Assign every hunk a stable id and work out, for each of its body lines,
 * whether it is a change and where it lands in the head-side file.
 */
export function indexDiff(files: FileDiff[]): DiffIndex {
  const hunks: IndexedHunk[] = [];
  const seenPerPath = new Map<string, number>();

  for (const file of files) {
    const path = file.newPath ?? file.oldPath;
    if (!path) continue;
    for (const hunk of file.hunks) {
      const ordinal = seenPerPath.get(path) ?? 0;
      seenPerPath.set(path, ordinal + 1);

      const changedLines: number[] = [];
      const newLineNumbers: (number | null)[] = [];
      let newLine = hunk.newStart;
      hunk.lines.forEach((line, i) => {
        if (isChanged(line)) changedLines.push(i + 1);
        if (line.startsWith("-")) {
          newLineNumbers.push(null);
        } else if (line.startsWith("\\")) {
          newLineNumbers.push(null);
        } else {
          newLineNumbers.push(newLine);
          newLine += 1;
        }
      });

      hunks.push({
        id: `${path}#${ordinal}`,
        file: path,
        oldPath: file.oldPath,
        newPath: file.newPath,
        header: hunk.header,
        lines: hunk.lines,
        changedLines,
        newLineNumbers,
      });
    }
  }

  return {
    hunks,
    byId: new Map(hunks.map((h) => [h.id, h])),
    changedLineCount: hunks.reduce((n, h) => n + h.changedLines.length, 0),
  };
}

function fileLabel(hunk: IndexedHunk): string {
  if (!hunk.oldPath) return `${hunk.file} (added)`;
  if (!hunk.newPath) return `${hunk.oldPath} (deleted)`;
  if (hunk.oldPath !== hunk.newPath) {
    return `${hunk.newPath} (renamed from ${hunk.oldPath})`;
  }
  return hunk.file;
}

/**
 * Render the diff with the two numbers the model needs: the hunk-local line
 * number it cites when defining fragments, and the head-side file line so it
 * can line the diff up against what `read_file` returns.
 */
export function renderAnnotatedDiff(index: DiffIndex): string {
  const out: string[] = [];
  for (const hunk of index.hunks) {
    out.push(`=== HUNK ${hunk.id} — ${fileLabel(hunk)}`);
    out.push(`    ${hunk.header}`);
    hunk.lines.forEach((line, i) => {
      const bodyLine = String(i + 1).padStart(4);
      const fileLine = (hunk.newLineNumbers[i] ?? "").toString().padStart(6);
      out.push(`${bodyLine} ${fileLine} |${line}`);
    });
    out.push("");
  }
  return out.join("\n");
}
