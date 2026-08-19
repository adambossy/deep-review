import { parseArgs } from "node:util";
import { analyzePrCallGraph } from "./analyze.js";
import { createCallGraphReport, createCallPathReport } from "./report.js";

const USAGE = `Usage: pr-call-graph <pr-url> <function-name> [options]

Options:
  --out <file>   Write the HTML report to this path (default: call-graph-<fn>.html)
  --layout <l>   "stacked" (default), "columns" (callers | target | callee),
                 or "explorer" (recursive two-pane navigator over the changed path)
  --json         Print the raw analysis result as JSON instead of writing HTML
  --work-dir <d> Cache the clone/worktrees here instead of the tmp dir

Example:
  pr-call-graph https://github.com/vercel/swr/pull/2950 useSWR --out report.html`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      layout: { type: "string", default: "stacked" },
      json: { type: "boolean", default: false },
      "work-dir": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  const [prUrl, functionName] = positionals;
  if (values.help || !prUrl || !functionName) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const common = {
    prUrl,
    functionName,
    ...(values["work-dir"] ? { workDir: values["work-dir"] } : {}),
  };

  if (values.json) {
    const result = await analyzePrCallGraph(common);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (values.layout === "explorer") {
    const { result, outFile } = await createCallPathReport({
      ...common,
      ...(values.out ? { outFile: values.out } : {}),
    });
    console.log(
      `Walked call graph from "${functionName}": ${result.nodes.length} functions, ${result.edges.length} edges`,
    );
    console.log(`Report written to ${outFile}`);
    return;
  }

  if (values.layout !== "stacked" && values.layout !== "columns") {
    console.error(
      `Unknown layout "${values.layout}" (expected stacked, columns, or explorer)`,
    );
    process.exit(1);
  }
  const { result, outFile } = await createCallGraphReport({
    ...common,
    layout: values.layout,
    ...(values.out ? { outFile: values.out } : {}),
  });
  console.log(
    `Analyzed "${functionName}": ${result.callers.length} callers, ${result.callees.length} callees`,
  );
  console.log(`Report written to ${outFile}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
