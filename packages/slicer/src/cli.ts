import { parseArgs } from "node:util";
import process from "node:process";
import { writeFileSync } from "node:fs";
import { renderSliceReportsHtml } from "./html.js";
import { DEFAULT_MODEL, apiKeyEnvVars, hasApiKeyForModel } from "./agent.js";
import {
  buildSlicePrompt,
  defaultOutFile,
  loadRenderEntry,
  slicePr,
  writeSliceReport,
} from "./slice.js";

const USAGE = `Usage: pr-slice <pr-url> [options]
       pr-slice --render <slices.json>... --html <file>

Breaks a PR's diff into slices — sets of changes that each accomplish one
thing — ordered from most to least central to the PR's purpose.

Options:
  --out <file>     Write the JSON here (default: slices-<repo>-pr<n>.json)
  --html <file>    Also write an HTML report of the slices
  --render         Treat the positionals as saved slice JSON files and only
                   rebuild the HTML from them — no model call
  --model <id>     Model to use (default: gpt-5.6-sol, or DEEP_REVIEW_MODEL)
  --max-steps <n>  Cap the agent's tool-calling loop (default: 40)
  --work-dir <d>   Cache the clone/worktrees here instead of the tmp dir
  --dry-run        Print the prompt the agent would get, and stop
  --quiet          Only print the output path

Environment:
  OPENAI_API_KEY     Required for the default model.
  ANTHROPIC_API_KEY  Required for claude-* models.
  GROK_API_KEY       Required for grok-* models.
  GITHUB_TOKEN       Needed for private repos.
  LINEAR_API_KEY     Optional; enables linked-ticket context.

Examples:
  pr-slice https://github.com/vercel/swr/pull/2950 --html slices.html
  pr-slice --render slices-a.json slices-b.json --html both.html`;

/** Pick up API keys from a .env in the working directory or repo root. */
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
      model: { type: "string" },
      "max-steps": { type: "string" },
      "work-dir": { type: "string" },
      html: { type: "string" },
      render: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  const [prUrl] = positionals;
  if (values.help || !prUrl) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const log = values.quiet ? () => {} : (m: string) => console.error(m);

  if (values.render) {
    if (!values.html) {
      console.error("--render needs --html <file> to write to.");
      process.exit(1);
    }
    const entries = [];
    for (const file of positionals) {
      entries.push(
        await loadRenderEntry(
          file,
          values["work-dir"] ? values["work-dir"] : undefined,
        ),
      );
      log(`Loaded ${file}`);
    }
    writeFileSync(values.html, renderSliceReportsHtml(entries), "utf8");
    console.log(values.html);
    return;
  }

  const modelId = values.model ?? process.env.DEEP_REVIEW_MODEL ?? DEFAULT_MODEL;
  if (!values["dry-run"] && !hasApiKeyForModel(modelId)) {
    console.error(`${apiKeyEnvVars(modelId).join(" or ")} is not set.`);
    process.exit(1);
  }

  const progress = values.quiet
    ? {}
    : { onProgress: (m: string) => console.error(m) };

  if (values["dry-run"]) {
    console.log(
      await buildSlicePrompt({
        prUrl,
        ...(values["work-dir"] ? { workDir: values["work-dir"] } : {}),
        ...progress,
      }),
    );
    return;
  }

  const maxSteps = values["max-steps"] ? Number(values["max-steps"]) : undefined;
  if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) {
    console.error(`--max-steps must be a positive integer.`);
    process.exit(1);
  }

  const report = await slicePr({
    prUrl,
    ...(values["work-dir"] ? { workDir: values["work-dir"] } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...progress,
  });

  const outFile = writeSliceReport(report, values.out ?? defaultOutFile(report));

  if (values.html) {
    const entry = await loadRenderEntry(
      outFile,
      values["work-dir"] ? values["work-dir"] : undefined,
    );
    writeFileSync(values.html, renderSliceReportsHtml([entry]), "utf8");
    log(`HTML report written to ${values.html}`);
  }

  if (!values.quiet) {
    console.error("");
    report.slices.forEach((slice, i) => {
      const lines = slice.fragments.length;
      console.error(
        `${i + 1}. ${slice.title} (${lines} fragment${lines === 1 ? "" : "s"})`,
      );
    });
    console.error("");
  }
  console.log(outFile);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
