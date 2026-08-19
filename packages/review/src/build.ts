import {
  analyzePrCallPath,
  type CallPathResult,
  type SliceExplorerInput,
  type SliceInput,
} from "@deep-review/call-graph";
import type { DiffIndex } from "@deep-review/slicer";
import type { Fragment, SliceReport } from "@deep-review/slicer";

export interface BuildOptions {
  report: SliceReport;
  index: DiffIndex;
  /** Where the clone/worktrees are cached, shared with the slicing run. */
  workDir?: string;
  /** Analyze at most this many slices' call graphs. */
  maxGraphs?: number;
  onProgress?: (message: string) => void;
}

/** The fragment's own diff lines, sliced out of the hunk it sits in. */
function fragmentInput(fragment: Fragment, index: DiffIndex) {
  const hunk = index.byId.get(fragment.hunkId);
  if (!hunk) return null;
  const from = fragment.startLine - 1;
  const to = fragment.endLine;
  return {
    id: fragment.id,
    file: fragment.file,
    summary: fragment.summary,
    hunkHeader: hunk.header,
    lines: hunk.lines.slice(from, to),
    newLineNumbers: hunk.newLineNumbers.slice(from, to),
  };
}

/**
 * Build the explorer's input: each slice's fragments, plus the call graph
 * rooted at its target where it has one.
 *
 * Graph analysis is per-slice and best-effort. It starts a language service
 * over the whole checkout, so it is the slow part and the part most likely
 * to fail — a target the language service cannot resolve, or a language the
 * backends do not cover. A slice whose analysis fails still renders; it just
 * has no horizontal dimension, and the failure is reported rather than
 * swallowed.
 */
export async function buildSliceExplorerInput(
  options: BuildOptions,
): Promise<SliceExplorerInput> {
  const { report, index } = options;
  const log = options.onProgress ?? (() => {});
  const maxGraphs = options.maxGraphs ?? report.slices.length;

  const slices: SliceInput[] = [];
  let analyzed = 0;
  let skippedForBudget = 0;

  for (const slice of report.slices) {
    const fragments = slice.fragments
      .map((f) => fragmentInput(f, index))
      .filter((f): f is NonNullable<typeof f> => f !== null);

    let graph: CallPathResult | undefined;
    if (!slice.target) {
      log(`${slice.id}: no target named, skipping call graph.`);
    } else if (analyzed >= maxGraphs) {
      skippedForBudget++;
    } else {
      analyzed++;
      log(
        `${slice.id}: walking call graph from ${slice.target.name} (${analyzed}/${Math.min(maxGraphs, report.slices.length)})…`,
      );
      try {
        graph = await analyzePrCallPath({
          prUrl: report.pr.url,
          functionName: slice.target.name,
          ...(options.workDir ? { workDir: options.workDir } : {}),
        });
        log(
          `${slice.id}: ${graph.nodes.length} functions, ${graph.edges.length} edges.`,
        );
      } catch (error) {
        log(
          `${slice.id}: call graph unavailable (${error instanceof Error ? error.message : error}).`,
        );
      }
    }

    slices.push({
      id: slice.id,
      title: slice.title,
      summary: slice.summary,
      rationale: slice.rationale,
      ...(slice.target ? { target: slice.target } : {}),
      fragments,
      ...(graph ? { graph } : {}),
    });
  }

  if (skippedForBudget > 0) {
    log(
      `${skippedForBudget} slice${skippedForBudget === 1 ? "" : "s"} had a target but were not analyzed (--max-graphs ${maxGraphs}).`,
    );
  }

  return {
    prUrl: report.pr.url,
    prTitle: report.pr.title,
    repo: `${report.pr.owner}/${report.pr.repo}`,
    number: report.pr.number,
    overview: report.overview,
    slices,
  };
}
