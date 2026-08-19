import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  analyzePrCallGraph,
  analyzePrCallPath,
  type AnalyzeOptions,
  type PathOptions,
} from "./analyze.js";
import { renderCallPathExplorerHtml } from "./explorer.js";
import { renderCallGraphColumnsHtml, renderCallGraphHtml } from "./html.js";
import type { CallGraphResult, CallPathResult } from "./types.js";

export interface ReportOptions extends AnalyzeOptions {
  /** Output path for the HTML page. Defaults to ./call-graph-<fn>.html */
  outFile?: string;
  /**
   * "stacked" (default): callers above the target, callees below.
   * "columns": callers | target | callee, with clickable call sites.
   */
  layout?: "stacked" | "columns";
}

export interface Report {
  result: CallGraphResult;
  outFile: string;
}

/** Run the analysis and write a navigable HTML page for it. */
export async function createCallGraphReport(
  options: ReportOptions,
): Promise<Report> {
  const result = await analyzePrCallGraph(options);
  const outFile = path.resolve(
    options.outFile ?? `call-graph-${options.functionName}.html`,
  );
  const render =
    options.layout === "columns" ? renderCallGraphColumnsHtml : renderCallGraphHtml;
  writeFileSync(outFile, render(result));
  return { result, outFile };
}

export interface PathReportOptions extends PathOptions {
  /** Output path for the HTML page. Defaults to ./call-path-<fn>.html */
  outFile?: string;
}

/**
 * Recursively walk the call graph from the named function and write the
 * explorer page: a two-pane sliding navigator over the changed code path.
 */
export async function createCallPathReport(
  options: PathReportOptions,
): Promise<{ result: CallPathResult; outFile: string }> {
  const result = await analyzePrCallPath(options);
  const outFile = path.resolve(
    options.outFile ?? `call-path-${options.functionName}.html`,
  );
  writeFileSync(outFile, renderCallPathExplorerHtml(result));
  return { result, outFile };
}
