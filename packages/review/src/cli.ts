import { execFile } from "node:child_process";
import { existsSync, fstatSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { renderSliceExplorerHtml } from "@deep-review/call-graph";
import { parsePrTarget, prUrl } from "@deep-review/pr";
import {
  apiKeyEnvVars,
  DEFAULT_MODEL,
  defaultOutFile,
  hasApiKeyForModel,
  loadSliceReport,
  slicePr,
  writeSliceReport,
} from "@deep-review/slicer";
import { explorerInputFromReport } from "./build.js";
import {
  addPrToServer,
  ensureServer,
  findServer,
  listServerPrs,
  logFile,
  runDaemon,
  serverBusyOrAlive,
  stopServer,
} from "./daemon.js";
import {
  agentInstalled,
  agentLoaded,
  installAgent,
  loadEnvFile as loadWatcherEnv,
  plistPath,
  uninstallAgent,
  watcherLogFile,
} from "./launchAgent.js";
import type { AddOptions, PrRef, PrView } from "./registry.js";
import { serveExplorer, VERSION } from "./serve.js";
import {
  DEFAULT_INTERVAL_MS,
  pidAlive,
  readWatcherState,
  runWatcher,
  watcherStateFile,
} from "./watcher.js";

const USAGE = `Usage: pr-review <pr-url|pr-number>... [options]
       pr-review watch|serve|status|stop [options]

Slices each PR, then renders it as a two-axis explorer: slices stacked
vertically in priority order, each slice's call graph walkable horizontally
from the symbols in its diff. The pages are served by one long-lived local
server shared by every invocation: the first invocation starts it, later
ones add their PRs to it, and each PR lives at its own URL until the server
is stopped. PRs build in the background — the URL opens at once and turns
into the explorer when ready.

Commands:
  <pr>...           Add these PRs to the server (starting it if needed).
  watch             Review PRs as they are assigned to you. Turns itself on
                    at login and after a reboot; --off turns it back off.
  serve             Run the server in the foreground.
  status            What is being watched and what the server holds.
  stop              Stop watching, and stop the server.

Options:
  --repo <owner/repo>  Repo a bare PR number refers to (default: $DEEP_REVIEW_REPO)
  --slices <file>   Reuse a saved slice JSON instead of running the agent
  --save <file>     Also write the slice JSON from this run
  --wait            Stay attached until the added PRs are built
  --out <file>      Build locally and write the page here as a static copy
                    (navigation inert); implies --no-daemon
  --no-serve        With --out: write it and exit without serving
  --no-daemon       Build and serve in this process, for this PR alone;
                    Ctrl-C stops it (the pre-daemon behavior)
  --off             watch: stop watching.
  --interval <s>    watch: seconds between checks (default: ${DEFAULT_INTERVAL_MS / 1000})
  --foreground      watch: run the loop here instead of in the background
  --force           watch: install even from a path that may not outlive today
  --port <n>        serve/--no-daemon: listen on this port (default: $DEEP_REVIEW_PORT, else 64940)
  --concurrency <n> serve: how many PRs may build at once (default: 2)
  --max-graphs <n>  Analyze at most n slices' call graphs (default: all)
  --debug-marks     Hold Shift on the page to see why each symbol is marked as it is
  --work-dir <d>    Cache the clone/worktrees here instead of the tmp dir
  --model <id>      Model to use for slicing (default: ${DEFAULT_MODEL})
  --no-open         Don't open the page(s) in a browser
  --quiet           Only print the URL(s) (or, with --no-serve, the output path)

Environment:
  OPENAI_API_KEY     Required for the default model, unless --slices is given.
  ANTHROPIC_API_KEY  Required for claude-* models.
  GROK_API_KEY       Required for grok-* models.
  GITHUB_TOKEN       Needed for private repos.
  DEEP_REVIEW_REPO   <owner>/<repo> a bare PR number refers to.
  DEEP_REVIEW_PORT   Port the server binds by default (default: 64940).
  DEEP_REVIEW_HOME   Where the server keeps its lockfile, log and slice JSONs
                     (default: ~/.deep-review).
  LINEAR_API_KEY     Optional; enables linked-ticket context.

Examples:
  pr-review https://github.com/vercel/swr/pull/2950
  pr-review 2950 2951 2952 --repo vercel/swr
  pr-review 2950 --repo vercel/swr --slices slices.json
  pr-review watch
  pr-review status
  pr-review stop`;

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

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function intFlag(raw: string | undefined, flag: string, min = 0): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) fail(`${flag} must be an integer ≥ ${min}.`);
  return value;
}

/** The PR a saved slice JSON is about, without replaying the whole load. */
function targetFromSlices(file: string): PrRef {
  try {
    const { pr } = loadSliceReport(file);
    return { owner: pr.owner, repo: pr.repo, number: pr.number };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
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
      wait: { type: "boolean", default: false },
      "max-graphs": { type: "string" },
      "no-serve": { type: "boolean", default: false },
      "no-daemon": { type: "boolean", default: false },
      off: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      interval: { type: "string" },
      foreground: { type: "boolean", default: false },
      port: { type: "string" },
      concurrency: { type: "string" },
      "debug-marks": { type: "boolean", default: false },
      "work-dir": { type: "string" },
      model: { type: "string" },
      "no-open": { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  const log = values.quiet ? () => {} : (m: string) => console.error(m);
  const port = intFlag(values.port, "--port");
  if (port !== undefined && port > 65535) fail("--port must be a port number.");
  const concurrency = intFlag(values.concurrency, "--concurrency", 1);
  const maxGraphs = intFlag(values["max-graphs"], "--max-graphs");
  const workDir = values["work-dir"];

  const [command] = positionals;
  if (values.help || (!command && !values.slices)) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  if (command === "watch") {
    const intervalMs = intFlag(values.interval, "--interval", 30);
    const running = readWatcherState().runner;

    if (values.off) {
      uninstallAgent();
      // A watcher started with --foreground is not launchd's to stop.
      if (running && running.pid !== process.pid && pidAlive(running.pid)) {
        try {
          process.kill(running.pid, "SIGTERM");
        } catch {
          // Gone between the check and the signal; nothing to stop.
        }
      }
      log("Not watching.");
      return;
    }

    if (values.foreground) {
      // Started by launchd, which sources no profile: the keys captured at
      // install time are the only ones this process will ever see.
      loadWatcherEnv();
      log(`Watching PRs assigned to you every ${intervalMs ?? DEFAULT_INTERVAL_MS / 1000}s.`);
      await runWatcher({
        ...(intervalMs !== undefined ? { intervalMs: intervalMs * 1000 } : {}),
        onProgress: log,
      });
      return;
    }

    const result = installAgent({
      ...(intervalMs !== undefined ? { intervalMs: intervalMs * 1000 } : {}),
      ...(values.force ? { force: true } : {}),
    });
    log(
      `Watching PRs assigned to you, every ${intervalMs ?? DEFAULT_INTERVAL_MS / 1000}s.\n` +
        `Reviews appear at the server's index as they build; pr-review status shows both.\n` +
        `Carried into the background: ${result.captured.join(", ")}.\n` +
        `Log: ${watcherLogFile()}`,
    );
    return;
  }

  if (command === "serve") {
    const server = await runDaemon({
      ...(port !== undefined ? { port } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
      onProgress: log,
    });
    log(`Serving ${server.url} — press Ctrl-C to stop.`);
    console.log(server.url);
    await server.closed;
    process.exit(0);
  }

  if (command === "stop") {
    const wasWatching = agentInstalled() || readWatcherState().runner !== undefined;
    if (wasWatching) {
      uninstallAgent();
      const running = readWatcherState().runner;
      if (running && pidAlive(running.pid)) {
        try {
          process.kill(running.pid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }
    }
    const stopped = await stopServer();
    if (!wasWatching && !stopped) {
      log("Nothing was running.");
      return;
    }
    log(
      [wasWatching ? "Stopped watching." : null, stopped ? "Stopped the server." : null]
        .filter(Boolean)
        .join(" "),
    );
    return;
  }

  if (command === "status") {
    const watcher = readWatcherState();
    const live = watcher.runner !== undefined && pidAlive(watcher.runner.pid);
    if (live) {
      const last = watcher.lastPollAt
        ? `last checked ${Math.round((Date.now() - watcher.lastPollAt) / 1000)}s ago`
        : "no check yet";
      const held = Object.keys(watcher.seen).length;
      log(
        `Watching — ${last}, ${held} PR${held === 1 ? "" : "s"} seen` +
          `${agentLoaded() ? "" : " (this session only; not installed at login)"}.`,
      );
      if (watcher.lastError) log(`  last check failed: ${watcher.lastError}`);
    } else if (agentInstalled()) {
      log(`Watching is installed but not running; see ${watcherLogFile()}.`);
    } else {
      log("Not watching (pr-review watch turns it on).");
    }

    const url = await findServer();
    if (!url) {
      log("No server is running.");
      return;
    }
    const prs = await listServerPrs(url);
    log(`Serving ${url} — ${prs.length} PR${prs.length === 1 ? "" : "s"}.`);
    for (const pr of prs) {
      const note =
        pr.state === "ready"
          ? `${pr.slices} slices${pr.live ? ", live" : ""}`
          : (pr.error ?? pr.log[pr.log.length - 1] ?? "");
      console.log(
        `${pr.state.padEnd(8)} ${pr.key.padEnd(30)} ${new URL(pr.path, url).href}${note ? `  (${note})` : ""}`,
      );
    }
    return;
  }

  // Everything else names PRs. A bare number is only meaningful once a
  // repo names it; --slices with no target names its own.
  const defaultRepo = values.repo ?? process.env.DEEP_REVIEW_REPO;
  let targets: PrRef[];
  try {
    targets = positionals.map((p) => parsePrTarget(p, defaultRepo));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (values.slices) {
    if (!existsSync(values.slices)) fail(`${values.slices} does not exist.`);
    if (targets.length > 1) fail("--slices names one PR; give at most one target with it.");
    if (targets.length === 0) targets = [targetFromSlices(values.slices)];
  }

  // A fresh slicing run needs a key; find out here, not on the index page.
  if (!values.slices) {
    const modelId = values.model ?? DEFAULT_MODEL;
    if (!hasApiKeyForModel(modelId)) {
      fail(`${apiKeyEnvVars(modelId).join(" or ")} is not set (or pass --slices).`);
    }
  }

  // --out builds locally: the static copy comes from this process's own
  // build, so it cannot ride along with a daemon that builds elsewhere.
  const local = values["no-daemon"] || values["no-serve"] || values.out !== undefined;
  if (values["no-serve"] && !values.out) {
    fail("--no-serve needs --out: there would be nothing to show.");
  }
  if (local && targets.length > 1) {
    fail(`--${values["no-daemon"] ? "no-daemon" : "out"} handles one PR; give one target.`);
  }

  const addOptions: AddOptions = {
    // The daemon runs elsewhere; only absolute paths mean the same thing there.
    ...(values.slices ? { slicesFile: path.resolve(values.slices) } : {}),
    ...(values.save ? { save: path.resolve(values.save) } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(maxGraphs !== undefined ? { maxGraphs } : {}),
    ...(values["debug-marks"] ? { debugMarks: true } : {}),
    ...(workDir ? { workDir: path.resolve(workDir) } : {}),
  };

  if (local) {
    await runLocal(targets[0]!, addOptions, {
      out: values.out,
      noServe: values["no-serve"],
      port,
      noOpen: values["no-open"],
      quiet: values.quiet,
      log,
    });
    return;
  }

  const { url: serverUrl, started, serverVersion, missingGithubToken } = await ensureServer();
  log(started ? `Started the server at ${serverUrl} (log: ${logFile()}).` : `Using the server at ${serverUrl}.`);
  if (serverVersion) {
    log(
      `The running server is v${serverVersion}; this CLI is v${VERSION}. \`pr-review stop\` and re-add to match them.`,
    );
  }
  if (missingGithubToken) {
    log(
      "GITHUB_TOKEN is set here but the running server started without it; private repos will fail until `pr-review stop` and re-add.",
    );
  }

  const added: PrView[] = [];
  for (const target of targets) {
    const pr = await addPrToServer(serverUrl, target, addOptions);
    added.push(pr);
    const pageUrl = new URL(pr.path, serverUrl).href;
    log(`${pr.key}: ${pr.state === "ready" ? "already here" : pr.state}.`);
    console.log(pageUrl);
    if (!values["no-open"]) execFile("open", [pageUrl], () => {});
  }

  if (!values.wait) return;

  // Stay attached: mirror each PR's build log here until all are settled.
  // A poll can fail while the server's event loop is blocked on a long
  // clone; that means busy, not gone, so keep polling while the process
  // exists and give up only when it does not.
  const seen = new Map<string, number>(added.map((pr) => [pr.key, 0]));
  for (;;) {
    let prs: PrView[];
    try {
      prs = await listServerPrs(serverUrl);
    } catch {
      if (!serverBusyOrAlive()) fail("The server went away while building.");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    const mine = prs.filter((pr) => seen.has(pr.key));
    for (const pr of mine) {
      const from = seen.get(pr.key)!;
      for (const line of pr.log.slice(from)) log(`${pr.key}: ${line}`);
      seen.set(pr.key, pr.log.length);
    }
    if (mine.every((pr) => pr.state === "ready" || pr.state === "failed")) {
      const failed = mine.filter((pr) => pr.state === "failed");
      if (failed.length > 0) {
        fail(`${failed.map((pr) => pr.key).join(", ")} failed to build.`);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

interface LocalOptions {
  out: string | undefined;
  noServe: boolean;
  port: number | undefined;
  noOpen: boolean;
  quiet: boolean;
  log: (message: string) => void;
}

/**
 * The pre-daemon path, kept for two uses: a static copy (--out/--no-serve),
 * and a single-PR foreground server (--no-daemon) that dies with the
 * terminal instead of outliving it.
 */
async function runLocal(
  target: PrRef,
  options: AddOptions,
  cli: LocalOptions,
): Promise<void> {
  const { log } = cli;
  let reportFile: string;
  if (options.slicesFile) {
    reportFile = options.slicesFile;
    log(`Using slices from ${reportFile}`);
  } else {
    const report = await slicePr({
      prUrl: prUrl(target),
      ...(options.workDir ? { workDir: options.workDir } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(cli.quiet ? {} : { onProgress: log }),
    });
    reportFile = writeSliceReport(report, options.save ?? defaultOutFile(report));
    log(`Slices written to ${reportFile}`);
  }

  const { input, headDir } = await explorerInputFromReport(reportFile, {
    ...(options.workDir ? { workDir: options.workDir } : {}),
    ...(options.maxGraphs !== undefined ? { maxGraphs: options.maxGraphs } : {}),
    ...(options.debugMarks ? { debugMarks: true } : {}),
    ...(cli.quiet ? {} : { onProgress: log }),
  });

  const withGraphs = input.slices.filter((s) => s.graph).length;
  log(`${input.slices.length} slices, ${withGraphs} with a walkable call graph.`);

  // A static copy reads fine on its own; only symbol clicks need a server,
  // so it is rendered without a navBase — nothing to ask.
  if (cli.out) {
    writeFileSync(cli.out, renderSliceExplorerHtml(input), "utf8");
    log(`Static copy written to ${cli.out}`);
  }
  if (cli.noServe) {
    console.log(cli.out);
    return;
  }

  const server = await serveExplorer({
    headDir,
    input,
    ...(cli.port !== undefined ? { port: cli.port } : {}),
    ...(cli.quiet ? {} : { onProgress: log }),
  });
  log(`Serving ${server.pageUrl} — press Ctrl-C to stop.`);
  console.log(server.pageUrl);
  if (!cli.noOpen) execFile("open", [server.pageUrl], () => {});

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
