import { readFileSync, writeFileSync } from "node:fs";
import {
  extractIssueIdentifiers,
  fetchLinearIssues,
  fetchPrInfo,
  isLinearConfigured,
  parsePrUrl,
  parseUnifiedDiff,
  prepareCheckouts,
} from "@deep-review/pr";
import { runSliceAgent, type ReasoningEffort } from "./agent.js";
import { indexDiff, type DiffIndex } from "./annotate.js";
import type { RenderEntry } from "./html.js";
import { buildPrompt } from "./prompt.js";
import { sliceReportSchema } from "./schema.js";
import type { PrContext, SliceReport } from "./types.js";

export interface SliceOptions {
  prUrl: string;
  /** Where to cache the clone + worktrees. Defaults to a per-PR tmp dir. */
  workDir?: string;
  model?: string;
  effort?: ReasoningEffort;
  maxSteps?: number;
  maxRepairs?: number;
  onProgress?: (message: string) => void;
}

/**
 * Gather everything about the PR that is knowable without judgment: its
 * metadata, its linked tickets, and both worktrees. The agent's turns are
 * spent on the parts that need judgment, not on fetching.
 */
async function gatherContext(options: SliceOptions): Promise<PrContext> {
  const report = options.onProgress ?? (() => {});
  const ref = parsePrUrl(options.prUrl);
  const info = await fetchPrInfo(ref);
  report(`${info.owner}/${info.repo}#${info.number} — ${info.title}`);

  const identifiers = extractIssueIdentifiers(
    info.body,
    info.title,
    info.headRef,
  );
  let tickets: Awaited<ReturnType<typeof fetchLinearIssues>> = [];
  if (identifiers.length > 0 && !isLinearConfigured()) {
    report(
      `Found ${identifiers.join(", ")} in the PR but LINEAR_API_KEY is not set; continuing without ticket context.`,
    );
  } else if (identifiers.length > 0) {
    tickets = await fetchLinearIssues(identifiers);
    report(
      tickets.length > 0
        ? `Linked tickets: ${tickets.map((t) => t.identifier).join(", ")}.`
        : `No Linear tickets resolved from ${identifiers.join(", ")}.`,
    );
  }

  const checkouts = prepareCheckouts(info, options.workDir);
  report(
    `Checked out ${checkouts.mergeBaseSha.slice(0, 8)}..${info.headSha.slice(0, 8)} (merge base to head).`,
  );

  return {
    info,
    tickets,
    baseDir: checkouts.baseDir,
    headDir: checkouts.headDir,
    mergeBaseSha: checkouts.mergeBaseSha,
    diffText: checkouts.diffText,
  };
}

export async function prepare(
  options: SliceOptions,
): Promise<{ context: PrContext; index: DiffIndex }> {
  const report = options.onProgress ?? (() => {});
  const context = await gatherContext(options);

  const index = indexDiff(parseUnifiedDiff(context.diffText));
  if (index.changedLineCount === 0) {
    throw new Error("The PR's diff has no changed lines.");
  }
  report(
    `Diff: ${index.hunks.length} hunks, ${index.changedLineCount} changed lines.`,
  );
  return { context, index };
}

/**
 * The exact prompt the agent would receive. Useful on its own: the annotated
 * diff is the contract between the prompt and the validator, so being able to
 * read it without spending a model call is worth the small amount of API.
 */
export async function buildSlicePrompt(options: SliceOptions): Promise<string> {
  const { context, index } = await prepare(options);
  return buildPrompt(context, index);
}

/** Slice one PR's diff into prioritized groups of fragments. */
export async function slicePr(options: SliceOptions): Promise<SliceReport> {
  const { context, index } = await prepare(options);

  const { overview, slices, model } = await runSliceAgent(context, index, {
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
    ...(options.maxRepairs !== undefined ? { maxRepairs: options.maxRepairs } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  return {
    pr: {
      url: context.info.htmlUrl,
      owner: context.info.owner,
      repo: context.info.repo,
      number: context.info.number,
      title: context.info.title,
      baseSha: context.info.baseSha,
      mergeBaseSha: context.mergeBaseSha,
      headSha: context.info.headSha,
    },
    tickets: context.tickets,
    overview,
    slices,
    model,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Rebuild the diff a saved report was produced from, so the report can be
 * re-rendered without re-running the agent. The checkout is cached, so this
 * is cheap on a PR that has been sliced before.
 */
/** Parse and validate a saved slice report, without touching the network. */
export function loadSliceReport(reportFile: string): SliceReport {
  const parsed = sliceReportSchema.safeParse(
    JSON.parse(readFileSync(reportFile, "utf8")),
  );
  if (!parsed.success) {
    throw new Error(
      `${reportFile} is not a slice report: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data as SliceReport;
}

export async function loadRenderEntry(
  reportFile: string,
  workDir?: string,
): Promise<RenderEntry> {
  const report = loadSliceReport(reportFile);
  const info = await fetchPrInfo({
    owner: report.pr.owner,
    repo: report.pr.repo,
    number: report.pr.number,
  });
  const checkouts = prepareCheckouts(info, workDir);
  return {
    report,
    index: indexDiff(parseUnifiedDiff(checkouts.diffText)),
    baseDir: checkouts.baseDir,
    headDir: checkouts.headDir,
  };
}

export function writeSliceReport(report: SliceReport, outFile: string): string {
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return outFile;
}

export function defaultOutFile(report: SliceReport): string {
  return `slices-${report.pr.repo}-pr${report.pr.number}.json`;
}
