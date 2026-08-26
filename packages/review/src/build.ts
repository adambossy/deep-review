import {
  analyzePrCallPath,
  embedHeadFiles,
  type CallPathResult,
  type EmbeddedFile,
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
  /** The head worktree, read for the context around each fragment. */
  headDir?: string;
  /** Analyze at most this many slices' call graphs. */
  maxGraphs?: number;
  /** Debug builds: every symbol on the page explains its marking while Shift is held. */
  debugMarks?: boolean;
  onProgress?: (message: string) => void;
}

/** The fragment's own diff lines, sliced out of the hunk it sits in. */
function fragmentInput(fragment: Fragment, index: DiffIndex) {
  const hunk = index.byId.get(fragment.hunkId);
  if (!hunk) return null;
  const from = fragment.startLine - 1;
  const to = fragment.endLine;
  const newLineNumbers = hunk.newLineNumbers.slice(from, to);

  // Where the fragment sits in the head-side file, which is what orders it
  // among its file's other fragments. A fragment that only removes lines
  // has no head-side extent of its own, so it is anchored between the lines
  // that survive around it: headEnd one before headStart, an empty range.
  const heads = newLineNumbers.filter((n): n is number => n !== null);
  let headStart: number;
  let headEnd: number;
  if (heads.length > 0) {
    headStart = heads[0]!;
    headEnd = heads[heads.length - 1]!;
  } else {
    const after = hunk.newLineNumbers.slice(to).find((n) => n != null);
    const before = hunk.newLineNumbers
      .slice(0, from)
      .reduce<number | null>((last, n) => n ?? last, null);
    // Nothing on either side means the hunk is all removals; anchor at the
    // first head line the hunk covers, or the top of the file.
    const first = hunk.newLineNumbers.find((n) => n != null);
    headStart = after ?? (before !== null ? before + 1 : (first ?? 1));
    headEnd = headStart - 1;
  }

  return {
    id: fragment.id,
    file: fragment.file,
    summary: fragment.summary,
    hunkHeader: hunk.header,
    lines: hunk.lines.slice(from, to),
    newLineNumbers,
    headStart,
    headEnd,
  };
}

/**
 * Head-side text and symbols of every file the slices touch, so a file's
 * fragments can be shown as one continuous stretch with real context
 * between them and every pane knows which scope it is in. Files the PR
 * deleted are absent from the head worktree and simply omitted; the
 * renderer falls back to fragment-by-fragment for those.
 */
async function readChangedFiles(
  report: SliceReport,
  headDir: string,
  log: (message: string) => void,
): Promise<EmbeddedFile[]> {
  const paths = new Set(
    report.slices.flatMap((s) => s.fragments.map((f) => f.file)),
  );
  const files = await embedHeadFiles(headDir, paths);
  const missing = paths.size - files.length;
  if (missing > 0) {
    log(`${missing} changed file${missing === 1 ? "" : "s"} not in the head checkout (deleted?); shown without context.`);
  }
  return files;
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

  // Symbol navigation is not part of the input: the page asks the local
  // navigation server about a symbol when it is clicked (see serve.ts).
  return {
    prUrl: report.pr.url,
    prTitle: report.pr.title,
    repo: `${report.pr.owner}/${report.pr.repo}`,
    number: report.pr.number,
    overview: report.overview,
    slices,
    files: options.headDir
      ? await readChangedFiles(report, options.headDir, log)
      : [],
    ...(options.debugMarks ? { debugMarks: true } : {}),
  };
}
