import type { FileDiff } from "@deep-review/pr";

/** A function rename visible in the PR diff. */
export interface RenamePair {
  /** Old-side repo-relative path. */
  oldFile: string;
  /** New-side repo-relative path. */
  newFile: string;
  oldName: string;
  newName: string;
}

const PY_DECL = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/;
const TS_DECL_PATTERNS = [
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*[(<]/,
  /\bclass\s+([A-Za-z_$][\w$]*)\b/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
];

function declaredName(content: string, path: string): string | null {
  if (path.endsWith(".py")) {
    return PY_DECL.exec(content)?.[1] ?? null;
  }
  for (const pattern of TS_DECL_PATTERNS) {
    const name = pattern.exec(content)?.[1];
    if (name) return name;
  }
  return null;
}

interface DeclLine {
  name: string;
  /** Index of the line within the hunk, for proximity pairing. */
  index: number;
}

/**
 * Function renames visible in the diff: within one hunk, a removed
 * declaration line whose name never reappears on the added side, paired
 * with an added declaration line whose name never appears on the removed
 * side. A declaration whose name survives (signature-only change) is not
 * a rename. Ambiguity is resolved by proximity within the hunk.
 */
export function detectRenamedDeclarations(files: FileDiff[]): RenamePair[] {
  const pairs: RenamePair[] = [];
  for (const file of files) {
    if (!file.oldPath || !file.newPath) continue;
    for (const hunk of file.hunks) {
      const removed: DeclLine[] = [];
      const added: DeclLine[] = [];
      hunk.lines.forEach((line, index) => {
        const side =
          line.startsWith("-") ? removed : line.startsWith("+") ? added : null;
        if (!side) return;
        const name = declaredName(line.slice(1), file.newPath!);
        if (name) side.push({ name, index });
      });
      const removedNames = new Set(removed.map((d) => d.name));
      const addedNames = new Set(added.map((d) => d.name));
      const gone = removed.filter((d) => !addedNames.has(d.name));
      const fresh = added.filter((d) => !removedNames.has(d.name));

      const taken = new Set<DeclLine>();
      for (const old of gone) {
        let best: DeclLine | null = null;
        for (const candidate of fresh) {
          if (taken.has(candidate)) continue;
          if (
            !best ||
            Math.abs(candidate.index - old.index) < Math.abs(best.index - old.index)
          ) {
            best = candidate;
          }
        }
        if (!best) continue;
        taken.add(best);
        pairs.push({
          oldFile: file.oldPath,
          newFile: file.newPath,
          oldName: old.name,
          newName: best.name,
        });
      }
    }
  }
  return pairs;
}

/**
 * Names a function may have had on the other side of the PR: the old names
 * when looking backward from a new name (side "old"), or the new names when
 * looking forward from an old name (side "new").
 */
export function renamedCounterparts(
  files: FileDiff[],
  name: string,
  side: "old" | "new",
): string[] {
  const pairs = detectRenamedDeclarations(files);
  return side === "old"
    ? pairs.filter((p) => p.newName === name).map((p) => p.oldName)
    : pairs.filter((p) => p.oldName === name).map((p) => p.newName);
}
