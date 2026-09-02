import { execFile } from "node:child_process";
import { existsSync, fstatSync, writeFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { renderSliceExplorerHtml } from "@deep-review/call-graph";
import { parsePrTarget, prUrl } from "@deep-review/pr";
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
import { serveExplorer } from "./serve.js";

const USAGE = `Usage: pr-review <pr-url|pr-number> [options]

Slices a PR, then renders it as a two-axis explorer: slices stacked
vertically in priority order, each slice's call graph walkable horizontally
from the symbols in its diff. Serves the page from a local server that
answers symbol clicks from the language services; Ctrl-C stops it.

Options:
  --repo <owner/repo>  Repo a bare PR number refers to (default: $DEEP_REVIEW_REPO)
  --slices <file>   Reuse a saved slice JSON instead of running the agent
  --save <file>     Also write the slice JSON from this run
  --out <file>      Also write the page here as a static copy (navigation inert)
  --no-serve        Write --out and exit instead of serving the page
  --port <n>        Serve on this port (default: a free one)
  --max-graphs <n>  Analyze at most n slices' call graphs (default: all)
  --debug-marks     Hold Shift on the page to see why each symbol is marked as it is
  --work-dir <d>    Cache the clone/worktrees here instead of the tmp dir
  --model <id>      Model to use for slicing (default: gpt-5.6-sol)
  --no-open         Don't open the page in a browser
  --quiet           Only print the URL (or, with --no-serve, the output path)

Environment:
  OPENAI_API_KEY     Required for the default model, unless --slices is given.
  ANTHROPIC_API_KEY  Required for claude-* models.
  GROK_API_KEY       Required for grok-* models.
  GITHUB_TOKEN       Needed for private repos.
  DEEP_REVIEW_REPO   <owner>/<repo> a bare PR number refers to.
  LINEAR_API_KEY     Optional; enables linked-ticket context.

Examples:
  pr-review https://github.com/vercel/swr/pull/2950
  pr-review https://github.com/vercel/swr/pull/2950 --slices slices.json
  pr-review 2950 --repo vercel/swr`;

function stdinIsPipe(): boolean {
  try {
    const stat = fstatSync(0);
    return stat.isFIFO() || stat.isSocket();
  } catch {
    return false;
  }
}

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
      repo: { type: "string" },
      slices: { type: "string" },
      save: { type: "string" },
      "max-graphs": { type: "string" },
      "no-serve": { type: "boolean", default: false },
      port: { type: "string" },
      "debug-marks": { type: "boolean", default: false },
      "work-dir": { type: "string" },
      model: { type: "string" },
      "no-open": { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  const [prTarget] = positionals;
  if (values.help || (!prTarget && !values.slices)) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  // A bare PR number is only meaningful once a repo names it.
  let prUrlArg: string | undefined;
  if (prTarget) {
    try {
      prUrlArg = prUrl(
        parsePrTarget(prTarget, values.repo ?? process.env.DEEP_REVIEW_REPO),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
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
  const port = values.port ? Number(values.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    console.error("--port must be a port number.");
    process.exit(1);
  }
  if (values["no-serve"] && !values.out) {
    console.error("--no-serve needs --out: there would be nothing to show.");
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
      prUrl: prUrlArg!,
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

  const { report, diff, index, headDir } = await loadRenderEntry(reportFile, workDir);
  const input = await buildSliceExplorerInput({
    report,
    diff,
    index,
    headDir,
    ...(workDir ? { workDir } : {}),
    ...(maxGraphs !== undefined ? { maxGraphs } : {}),
    ...(values["debug-marks"] ? { debugMarks: true } : {}),
    ...(values.quiet ? {} : { onProgress: log }),
  });
  const html = renderSliceExplorerHtml(input);

  const withGraphs = input.slices.filter((s) => s.graph).length;
  log(
    `${input.slices.length} slices, ${withGraphs} with a walkable call graph.`,
  );

  // A static copy reads fine on its own; only symbol clicks need the server.
  if (values.out) {
    writeFileSync(values.out, html, "utf8");
    log(`Static copy written to ${values.out}`);
  }
  if (values["no-serve"]) {
    console.log(values.out);
    return;
  }

  const server = await serveExplorer({
    headDir,
    input,
    html,
    ...(port !== undefined ? { port } : {}),
    ...(values.quiet ? {} : { onProgress: log }),
  });
  log(`Serving ${server.url} — press Ctrl-C to stop.`);
  console.log(server.url);
  if (!values["no-open"]) {
    execFile("open", [server.url], () => {});
  }

  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  // Started by another program over a pipe rather than from a terminal: go
  // when it does. (Not for a stdin that is simply /dev/null — that ends at
  // once and says nothing about anyone leaving.)
  if (stdinIsPipe()) {
    process.stdin.once("end", stop);
    process.stdin.resume();
  }
  await server.closed;
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
