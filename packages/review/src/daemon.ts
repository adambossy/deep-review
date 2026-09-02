/**
 * The navigation server as something that outlives a terminal: where its
 * lockfile lives, how a CLI invocation finds a running one or starts one
 * detached, and the build function the running server turns PR URLs into
 * pages with.
 *
 * The lockfile under the state dir (`~/.deep-review`, or $DEEP_REVIEW_HOME)
 * names the port a server claims to listen on; the claim is only believed
 * after `/health` answers, so a machine that rebooted or a server that was
 * killed leaves nothing worse than a stale file to overwrite.
 */

import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { renderSliceExplorerHtml } from "@deep-review/call-graph";
import {
  defaultOutFile,
  loadRenderEntry,
  slicePr,
  writeSliceReport,
} from "@deep-review/slicer";
import { buildSliceExplorerInput } from "./build.js";
import type { AddOptions, BuildPr, PrView } from "./registry.js";
import { startNavServer, VERSION, type NavServer } from "./serve.js";

export function stateDir(): string {
  return process.env.DEEP_REVIEW_HOME ?? path.join(os.homedir(), ".deep-review");
}

export function lockFile(): string {
  return path.join(stateDir(), "server.json");
}

export function logFile(): string {
  return path.join(stateDir(), "server.log");
}

export interface ServerLock {
  pid: number;
  port: number;
  url: string;
  version: string;
  startedAt: number;
}

export function readLock(): ServerLock | null {
  try {
    const lock = JSON.parse(readFileSync(lockFile(), "utf8")) as ServerLock;
    return Number.isInteger(lock.port) && Number.isInteger(lock.pid) ? lock : null;
  } catch {
    return null;
  }
}

/** The lock's claim, verified: the server there answered `/health`. */
export async function probe(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", url), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

/** A verified running server's URL, or null. */
export async function findServer(): Promise<string | null> {
  const lock = readLock();
  if (!lock) return null;
  return (await probe(lock.url)) ? lock.url : null;
}

/**
 * The build the daemon runs when a PR is added: slice it (or reuse a saved
 * slice JSON), walk each slice's call graph, render the page under the
 * prefix the server will mount it at. The slice JSON of a fresh run is kept
 * under the state dir so adding the same PR after a restart skips the model.
 */
export const daemonBuild: BuildPr = async ({ prUrl, navBase, options }, log) => {
  let reportFile: string;
  if (options.slicesFile) {
    reportFile = options.slicesFile;
    log(`using slices from ${reportFile}`);
  } else {
    const report = await slicePr({
      prUrl,
      ...(options.workDir ? { workDir: options.workDir } : {}),
      ...(options.model ? { model: options.model } : {}),
      onProgress: log,
    });
    const slicesDir = path.join(stateDir(), "slices");
    mkdirSync(slicesDir, { recursive: true });
    reportFile = writeSliceReport(
      report,
      options.save ?? path.join(slicesDir, defaultOutFile(report)),
    );
    log(`slices written to ${reportFile}`);
  }

  const { report, index, headDir } = await loadRenderEntry(reportFile, options.workDir);
  const input = {
    ...(await buildSliceExplorerInput({
      report,
      index,
      headDir,
      ...(options.workDir ? { workDir: options.workDir } : {}),
      ...(options.maxGraphs !== undefined ? { maxGraphs: options.maxGraphs } : {}),
      ...(options.debugMarks ? { debugMarks: true } : {}),
      onProgress: log,
    })),
    navBase,
  };
  return { input, headDir, html: renderSliceExplorerHtml(input) };
};

export interface RunDaemonOptions {
  port?: number | undefined;
  concurrency?: number | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

/**
 * Run the server in this process and stake the lockfile claim. Refuses to
 * start while a verified server is already up — two servers means two
 * lockfile writers and split PRs. The claim is withdrawn on any exit path
 * that runs code: `/quit`, Ctrl-C, SIGTERM.
 */
export async function runDaemon(options: RunDaemonOptions = {}): Promise<NavServer> {
  const existing = await findServer();
  if (existing) {
    throw new Error(`A server is already running at ${existing} (pr-review stop to stop it).`);
  }
  const server = await startNavServer({
    build: daemonBuild,
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  mkdirSync(stateDir(), { recursive: true });
  const lock: ServerLock = {
    pid: process.pid,
    port: server.port,
    url: server.url,
    version: VERSION,
    startedAt: Date.now(),
  };
  writeFileSync(lockFile(), JSON.stringify(lock, null, 2));

  const releaseLock = (): void => {
    // Only withdraw our own claim; a newer server may have overwritten it.
    if (readLock()?.pid === process.pid) rmSync(lockFile(), { force: true });
  };
  void server.closed.then(releaseLock);
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return server;
}

/**
 * Find the running server or start one detached from this terminal — its
 * own session, stdio to the server log — and wait for it to answer. The
 * spawned process is this same CLI with `serve`, so there is exactly one
 * code path a server starts through.
 */
export async function ensureServer(): Promise<{ url: string; started: boolean }> {
  const existing = await findServer();
  if (existing) return { url: existing, started: false };

  mkdirSync(stateDir(), { recursive: true });
  const log = openSync(logFile(), "a");
  // Re-run this same CLI with `serve`, carrying this process's own loader
  // flags: run through tsx the CLI is a .ts file plain node cannot take,
  // and execArgv is exactly the stack that made it runnable here.
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "serve"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();

  // The server writes its lockfile only once it is listening; believe it
  // when /health answers. A model-heavy machine can be slow to boot Node,
  // so give it a real moment before declaring failure.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const url = await findServer();
    if (url) return { url, started: true };
    if (child.exitCode !== null && child.exitCode !== 0) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`The server did not come up; see ${logFile()}.`);
}

/** Ask the running server to add a PR; it builds in the background there. */
export async function addPrToServer(
  serverUrl: string,
  ref: { owner: string; repo: string; number: number; prUrl: string },
  options: AddOptions,
): Promise<PrView> {
  const response = await fetch(new URL("/prs", serverUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...ref, options }),
  });
  const body = (await response.json()) as { pr?: PrView; why?: string };
  if (!response.ok || !body.pr) {
    throw new Error(body.why ?? `the server said ${response.status}`);
  }
  return body.pr;
}

export async function listServerPrs(serverUrl: string): Promise<PrView[]> {
  const response = await fetch(new URL("/prs", serverUrl));
  if (!response.ok) throw new Error(`the server said ${response.status}`);
  return ((await response.json()) as { prs: PrView[] }).prs;
}

/** Stop the running server, if any. True when there was one to stop. */
export async function stopServer(): Promise<boolean> {
  const url = await findServer();
  if (!url) {
    // No live server; clear a stale claim so the next start is clean.
    rmSync(lockFile(), { force: true });
    return false;
  }
  await fetch(new URL("/quit", url), { method: "POST" });
  return true;
}
