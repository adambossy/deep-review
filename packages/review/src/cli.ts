import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { renderSliceExplorerHtml } from "@deep-review/call-graph";
import {
  apiKeyEnvVars,
  DEFAULT_MODEL,
  defaultOutFile,
  hasApiKeyForModel,
  loadRenderEntry,
  slicePr,
  writeSliceReport,
} from "@deep-review/slicer";
import { buildSliceExplorerInput } from "./build.js";

const USAGE = `Usage: pr-review <pr-url> [options]

Slices a PR, then renders it as a two-axis explorer: slices stacked
vertically in priority order, each slice's call graph walkable horizontally
from the symbols in its diff.

Options:
  --out <file>      Write the HTML here (default: review-<repo>-pr<n>.html)
  --slices <file>   Reuse a saved slice JSON instead of running the agent
  --save <file>     Also write the slice JSON from this run
  --max-graphs <n>  Analyze at most n slices' call graphs (default: all)
  --no-nav          Skip resolving symbols to definitions (only call-graph symbols tappable)
  --nav-budget <n>  Cap language-service lookups for symbol navigation (default: 20000)
  --debug-marks     Hold Shift on the page to see why each symbol is (or is not) tappable
  --work-dir <d>    Cache the clone/worktrees here instead of the tmp dir
  --model <id>      Model to use for slicing (default: gpt-5.6-sol)
  --no-open         Don't open the report in a browser
  --quiet           Only print the output path

Environment:
  OPENAI_API_KEY     Required for the default model, unless --slices is given.
  ANTHROPIC_API_KEY  Required for claude-* models.
  GROK_API_KEY       Required for grok-* models.
  GITHUB_TOKEN       Needed for private repos.
  LINEAR_API_KEY     Optional; enables linked-ticket context.

Examples:
  pr-review https://github.com/vercel/swr/pull/2950
  pr-review https://github.com/vercel/swr/pull/2950 --slices slices.json`;

function loadEnvFile(): void {
  for (const candidate of [".env", "../../.env"]) {
    try {
      process.loadEnvFile(candidate);
      return;
    } catch {
      // No file there; try the next.
    }
  }
}

async function main(): Promise<void> {
  loadEnvFile();

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      slices: { type: "string" },
      save: { type: "string" },
      "max-graphs": { type: "string" },
      "no-nav": { type: "boolean", default: false },
      "nav-budget": { type: "string" },
      "debug-marks": { type: "boolean", default: false },
      "work-dir": { type: "string" },
      model: { type: "string" },
      "no-open": { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  const [prUrl] = positionals;
  if (values.help || (!prUrl && !values.slices)) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const log = values.quiet ? () => {} : (m: string) => console.error(m);
  const workDir = values["work-dir"];
  const maxGraphs = values["max-graphs"]
    ? Number(values["max-graphs"])
    : undefined;
  if (maxGraphs !== undefined && (!Number.isInteger(maxGraphs) || maxGraphs < 0)) {
    console.error("--max-graphs must be a non-negative integer.");
    process.exit(1);
  }
  const navBudget = values["nav-budget"] ? Number(values["nav-budget"]) : undefined;
  if (navBudget !== undefined && (!Number.isInteger(navBudget) || navBudget < 0)) {
    console.error("--nav-budget must be a non-negative integer.");
    process.exit(1);
  }

  // Either reuse a saved slicing run or pay for a fresh one.
  let reportFile: string;
  if (values.slices) {
    if (!existsSync(values.slices)) {
      console.error(`${values.slices} does not exist.`);
      process.exit(1);
    }
    reportFile = values.slices;
    log(`Using slices from ${reportFile}`);
  } else {
    const modelId = values.model ?? DEFAULT_MODEL;
    if (!hasApiKeyForModel(modelId)) {
      console.error(`${apiKeyEnvVars(modelId).join(" or ")} is not set (or pass --slices).`);
      process.exit(1);
    }
    const report = await slicePr({
      prUrl: prUrl!,
      ...(workDir ? { workDir } : {}),
      ...(values.model ? { model: values.model } : {}),
      ...(values.quiet ? {} : { onProgress: log }),
    });
    reportFile = writeSliceReport(
      report,
      values.save ?? defaultOutFile(report),
    );
    log(`Slices written to ${reportFile}`);
  }

  const { report, index, headDir } = await loadRenderEntry(reportFile, workDir);
  const input = await buildSliceExplorerInput({
    report,
    index,
    headDir,
    ...(workDir ? { workDir } : {}),
    ...(maxGraphs !== undefined ? { maxGraphs } : {}),
    navigation: !values["no-nav"],
    ...(navBudget !== undefined ? { navBudget } : {}),
    ...(values["debug-marks"] ? { debugMarks: true } : {}),
    ...(values.quiet ? {} : { onProgress: log }),
  });

  const outFile =
    values.out ?? `review-${report.pr.repo}-pr${report.pr.number}.html`;
  writeFileSync(outFile, renderSliceExplorerHtml(input), "utf8");

  const withGraphs = input.slices.filter((s) => s.graph).length;
  log(
    `${input.slices.length} slices, ${withGraphs} with a walkable call graph.`,
  );
  console.log(outFile);

  if (!values["no-open"]) {
    execFile("open", [path.resolve(outFile)], () => {});
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
