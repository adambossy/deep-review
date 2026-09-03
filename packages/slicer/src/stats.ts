import type { DiffIndex } from "./annotate.js";
import { FRAGMENT_KINDS, type Fragment, type FragmentKind, type SliceReport } from "./types.js";

/** Added and removed lines, the two numbers GitHub shows for a PR. */
export interface LineDelta {
  additions: number;
  deletions: number;
}

/** A line delta per fragment kind: the PR's size as three numbers. */
export type KindTotals = Record<FragmentKind, LineDelta>;

/**
 * Either a full breakdown or, for reports whose fragments were never
 * classified, the unsplit total. The `kinds` tag tells them apart.
 */
export type SizeTotals =
  | { kinds: true; byKind: KindTotals; total: LineDelta }
  | { kinds: false; total: LineDelta };

const zero = (): LineDelta => ({ additions: 0, deletions: 0 });

/** Count `+` and `-` prefixed lines; context and `\ No newline` are neither. */
export function countDelta(lines: readonly string[]): LineDelta {
  const delta = zero();
  for (const line of lines) {
    if (line.startsWith("+")) delta.additions++;
    else if (line.startsWith("-")) delta.deletions++;
  }
  return delta;
}

/**
 * The fragment's own +/-: its run of hunk body lines, context excluded. A
 * fragment whose hunk is missing from the index counts as nothing, the same
 * way the explorer drops it rather than throwing.
 */
export function fragmentDelta(fragment: Fragment, index: DiffIndex): LineDelta {
  const hunk = index.byId.get(fragment.hunkId);
  if (!hunk) return zero();
  return countDelta(hunk.lines.slice(fragment.startLine - 1, fragment.endLine));
}

function add(into: LineDelta, delta: LineDelta): void {
  into.additions += delta.additions;
  into.deletions += delta.deletions;
}

/**
 * Sum a set of fragments by kind. The split is only offered when every
 * fragment is classified: one unclassified fragment would land in no bucket
 * and the three numbers would quietly stop adding up to the total.
 */
export function fragmentTotals(fragments: readonly Fragment[], index: DiffIndex): SizeTotals {
  const total = zero();
  const byKind = Object.fromEntries(FRAGMENT_KINDS.map((k) => [k, zero()])) as KindTotals;
  let allClassified = true;
  for (const fragment of fragments) {
    const delta = fragmentDelta(fragment, index);
    add(total, delta);
    if (fragment.kind) add(byKind[fragment.kind], delta);
    else allClassified = false;
  }
  return allClassified ? { kinds: true, byKind, total } : { kinds: false, total };
}

/**
 * The whole PR's size. Slices partition the changed lines, so the sum over
 * every slice's fragments must equal the diff's own count; drift means a
 * fragment is missing, duplicated, or misaddressed, and is thrown rather
 * than shown.
 */
export function reportTotals(report: SliceReport, index: DiffIndex): SizeTotals {
  const totals = fragmentTotals(
    report.slices.flatMap((s) => s.fragments),
    index,
  );
  const { additions, deletions } = totals.total;
  if (additions !== index.additions || deletions !== index.deletions) {
    throw new Error(
      `Slice fragments sum to +${additions} −${deletions} but the diff has +${index.additions} −${index.deletions}.`,
    );
  }
  return totals;
}
