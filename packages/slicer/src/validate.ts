import type { DiffIndex } from "./annotate.js";
import type { AgentOutput } from "./schema.js";
import type { Fragment, Slice } from "./types.js";

export type ValidationResult =
  | { ok: true; slices: Slice[] }
  | { ok: false; errors: string[] };

/** Collapse [1,2,3,7,8] into ["1-3", "7-8"] so error messages stay short. */
function ranges(lines: number[]): string[] {
  const sorted = [...lines].sort((a, b) => a - b);
  const out: string[] = [];
  let start: number | undefined;
  let prev: number | undefined;
  for (const line of sorted) {
    if (start === undefined || prev === undefined) {
      start = prev = line;
    } else if (line === prev + 1) {
      prev = line;
    } else {
      out.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = prev = line;
    }
  }
  if (start !== undefined) {
    out.push(start === prev ? `${start}` : `${start}-${prev}`);
  }
  return out;
}

/**
 * Check that the agent's slices partition the diff, and turn them into the
 * report's slices with derived fragment ids.
 *
 * The partition is the invariant worth enforcing: a changed line that landed
 * in no slice is a judgment the agent silently declined to make, and one that
 * landed in two is a judgment it made twice. Neither is visible by reading
 * the output, so both are checked here.
 */
export function validateSlices(
  output: AgentOutput,
  index: DiffIndex,
): ValidationResult {
  const errors: string[] = [];
  /** hunkId -> body line -> the slice titles claiming it. */
  const claims = new Map<string, Map<number, string[]>>();
  const slices: Slice[] = [];

  output.slices.forEach((slice, sliceIndex) => {
    const fragments: Fragment[] = [];
    for (const fragment of slice.fragments) {
      const hunk = index.byId.get(fragment.hunkId);
      if (!hunk) {
        errors.push(
          `Slice "${slice.title}" references hunk "${fragment.hunkId}", which does not exist.`,
        );
        continue;
      }
      const { startLine, endLine } = fragment;
      if (endLine < startLine) {
        errors.push(
          `Slice "${slice.title}" has a fragment in ${hunk.id} with endLine ${endLine} before startLine ${startLine}.`,
        );
        continue;
      }
      if (endLine > hunk.lines.length) {
        errors.push(
          `Slice "${slice.title}" has a fragment running to line ${endLine} in ${hunk.id}, which has only ${hunk.lines.length} lines.`,
        );
        continue;
      }

      let hunkClaims = claims.get(hunk.id);
      if (!hunkClaims) {
        hunkClaims = new Map();
        claims.set(hunk.id, hunkClaims);
      }
      for (let line = startLine; line <= endLine; line++) {
        const owners = hunkClaims.get(line) ?? [];
        owners.push(slice.title);
        hunkClaims.set(line, owners);
      }

      fragments.push({
        id: `${hunk.id}@${startLine}-${endLine}`,
        hunkId: hunk.id,
        file: hunk.file,
        startLine,
        endLine,
        summary: fragment.summary,
      });
    }

    slices.push({
      id: `slice-${sliceIndex + 1}`,
      title: slice.title,
      summary: slice.summary,
      rationale: slice.rationale,
      ...(slice.target ? { target: slice.target } : {}),
      fragments,
    });
  });

  for (const hunk of index.hunks) {
    const hunkClaims = claims.get(hunk.id) ?? new Map<number, string[]>();
    const uncovered = hunk.changedLines.filter((l) => !hunkClaims.has(l));
    if (uncovered.length > 0) {
      errors.push(
        `Hunk ${hunk.id} has changed lines in no slice: ${ranges(uncovered).join(", ")}.`,
      );
    }
    const doubled = [...hunkClaims.entries()].filter(
      ([, owners]) => owners.length > 1,
    );
    if (doubled.length > 0) {
      const lines = ranges(doubled.map(([line]) => line)).join(", ");
      const owners = [...new Set(doubled.flatMap(([, o]) => o))].join('", "');
      errors.push(
        `Hunk ${hunk.id} lines ${lines} are claimed by more than one slice ("${owners}"). Every line belongs to exactly one.`,
      );
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, slices };
}
