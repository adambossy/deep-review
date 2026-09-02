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
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { renderSliceExplorerHtml } from "@deep-review/call-graph";
import { fetchPrInfo, parsePrUrl } from "@deep-review/pr";
import { loadSliceReport, slicePr, writeSliceReport } from "@deep-review/slicer";
import { explorerInputFromReport } from "./build.js";
import type { AddOptions, BuildPr, PrRef, PrView } from "./registry.js";
import { startNavServer, VERSION, type NavServer } from "./serve.js";

export function stateDir(): string {
  return process.env.DEEP_REVIEW_HOME ?? path.join(os.homedir(), ".deep-review");
}

function lockFile(): string {
  return path.join(stateDir(), "server.json");
}

export function logFile(): string {
  return path.join(stateDir(), "server.log");
}

interface ServerLock {
  pid: number;
  port: number;
  url: string;
  version: string;
  startedAt: number;
}

function readLock(): ServerLock | null {
  try {
    const lock = JSON.parse(readFileSync(lockFile(), "utf8")) as ServerLock;
    return Number.isInteger(lock.port) && Number.isInteger(lock.pid) ? lock : null;
  } catch {
    return null;
  }
}

/** The lock's claim, verified: what the server there says about itself, or null. */
async function probe(
  url: string,
  timeoutMs = 1500,
): Promise<{ version: string; hasGithubToken: boolean } | null> {
  try {
    const response = await fetch(new URL("/health", url), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      ok?: boolean;
      version?: string;
      hasGithubToken?: boolean;
    };
    if (body.ok !== true) return null;
    return { version: body.version ?? "0.0.0", hasGithubToken: body.hasGithubToken === true };
  } catch {
    return null;
  }
}

/** A verified running server's URL, or null. */
export async function findServer(): Promise<string | null> {
  const lock = readLock();
  if (!lock) return null;
  return (await probe(lock.url)) ? lock.url : null;
}

/**
 * Whether the lock's claimant exists as a process at all. The server runs
 * builds on its own event loop, and a clone of a large repo blocks it for
 * minutes — long enough for `/health` to time out. A dead probe with a live
 * pid means busy, not gone; only both dead means gone.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The running server's claim while it may be too busy to answer: its lock, pid-checked. */
export function serverBusyOrAlive(): { url: string; pid: number } | null {
  const lock = readLock();
  if (!lock || !pidAlive(lock.pid)) return null;
  return { url: lock.url, pid: lock.pid };
}

/**
 * Where the daemon caches one PR's clone and worktrees when the add carries
 * no --work-dir of its own. The library default is under os.tmpdir(), which
 * macOS purges periodically — fine for a one-shot CLI run, a re-clone tax
 * on a server that lives for weeks. Per PR, not shared: a work dir holds
 * `repo/`, `base/` and `head/` for exactly one PR (see prepareCheckouts),
 * and two PRs sharing one would swap each other's worktrees out from under
 * their language services.
 */
function defaultDaemonWorkDir(ref: PrRef): string {
  return path.join(
    stateDir(),
    "work",
    `${safeName(ref.owner)}-${safeName(ref.repo)}-pr${ref.number}`,
  );
}

/** One path-safe filename segment; GitHub names are tame, but the path must not care. */
function safeName(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * The slice JSON a fresh run of this PR is kept at. Keyed by the PR's full
 * identity — owner included, or `vercel/swr#100` and a fork's `swr#100`
 * would share a file.
 */
function cachedSliceFile(owner: string, repo: string, number: number): string {
  return path.join(
    stateDir(),
    "slices",
    `slices-${safeName(owner)}-${safeName(repo)}-pr${number}.json`,
  );
}

/** The head commit a saved slice report was made from, or null if unreadable. */
function reportHeadSha(file: string): string | null {
  try {
    return loadSliceReport(file).pr.headSha;
  } catch {
    return null;
  }
}

/**
 * The build the daemon runs when a PR is added: slice it, walk each slice's
 * call graph, render the page under the prefix the server will mount it at.
 * The slice JSON of a fresh run is kept under the state dir, and a kept one
 * whose head commit still matches the PR's is reused instead of paying for
 * the model again — a restart, or re-adding an unchanged PR, costs no slicing.
 * An explicit slice JSON (--slices) is trusted as given, no head check.
 */
const daemonBuild: BuildPr = async ({ prUrl, navBase, options }, log) => {
  const ref = parsePrUrl(prUrl);
  const workDir = options.workDir ?? defaultDaemonWorkDir(ref);
  mkdirSync(workDir, { recursive: true });

  let reportFile: string;
  if (options.slicesFile) {
    reportFile = options.slicesFile;
    log(`using slices from ${reportFile}`);
  } else {
    const info = await fetchPrInfo(ref);
    const cached = cachedSliceFile(info.owner, info.repo, info.number);
    if (existsSync(cached) && reportHeadSha(cached) === info.headSha) {
      reportFile = cached;
      log(`head unchanged at ${info.headSha.slice(0, 8)}; reusing slices from ${cached}`);
    } else {
      const report = await slicePr({
        prUrl,
        workDir,
        ...(options.model ? { model: options.model } : {}),
        onProgress: log,
      });
      mkdirSync(path.dirname(cached), { recursive: true });
      reportFile = writeSliceReport(report, cached);
      log(`slices written to ${reportFile}`);
    }
    // --save means "leave me the slice JSON" however the run was answered.
    if (options.save) copyFileSync(reportFile, options.save);
  }

  const built = await explorerInputFromReport(reportFile, {
    workDir,
    ...(options.maxGraphs !== undefined ? { maxGraphs: options.maxGraphs } : {}),
    ...(options.debugMarks ? { debugMarks: true } : {}),
    onProgress: log,
  });
  const input = { ...built.input, navBase };
  return {
    input,
    headDir: built.headDir,
    html: renderSliceExplorerHtml(input),
    headSha: built.report.pr.headSha,
  };
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
    // A re-added PR is only trusted while its head has not moved.
    currentHeadSha: async (ref) => (await fetchPrInfo(ref)).headSha,
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
  // The claim is contested through exclusive create: two first invocations
  // that both found no server will both reach here, and check-then-write
  // would leave the loser running forever with no lock pointing at it.
  // A loser defers to a live claimant and shuts itself down; a dead
  // claimant's file is cleared and the claim retried — but only while the
  // file still holds the claim that failed the probe, so a rival who won
  // the meantime is deferred to on the next pass, not deleted.
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(lockFile(), JSON.stringify(lock, null, 2), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 5) {
        await server.close();
        throw error;
      }
      const claimant = readLock();
      if (
        claimant &&
        claimant.pid !== process.pid &&
        ((await probe(claimant.url)) || pidAlive(claimant.pid))
      ) {
        await server.close();
        throw new Error(
          `A server is already running at ${claimant.url} (pr-review stop to stop it).`,
        );
      }
      const now = readLock();
      if (now && claimant && (now.pid !== claimant.pid || now.port !== claimant.port)) {
        continue; // someone else claimed while we probed; judge them next pass
      }
      rmSync(lockFile(), { force: true });
    }
  }

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
export interface EnsuredServer {
  url: string;
  started: boolean;
  /** Set when the running server's version differs from this CLI's, either way. */
  serverVersion?: string;
  /**
   * Set when this process has GITHUB_TOKEN but the running server does not.
   * The server keeps the env of whichever shell spawned it, so a token
   * exported later never reaches it — private-repo builds then fail with a
   * hint that blames the shell, which is the one place the token *is* set.
   */
  missingGithubToken?: boolean;
}

export async function ensureServer(): Promise<EnsuredServer> {
  const lock = readLock();
  if (lock) {
    const health = await probe(lock.url);
    if (health) {
      return {
        url: lock.url,
        started: false,
        ...(health.version !== VERSION ? { serverVersion: health.version } : {}),
        ...(process.env.GITHUB_TOKEN && !health.hasGithubToken
          ? { missingGithubToken: true }
          : {}),
      };
    }
    // Not answering but the process exists: a build is blocking its event
    // loop. Use it — spawning a rival because the incumbent is busy is how
    // two servers happen.
    if (pidAlive(lock.pid)) return { url: lock.url, started: false };
  }

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
  ref: PrRef,
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

/**
 * Stop the running server, if any, and wait until it is actually gone —
 * "stopped" that returns while the port and lockfile are still live would
 * make `pr-review stop && pr-review serve` flaky. True when there was one
 * to stop.
 */
export async function stopServer(): Promise<boolean> {
  const lock = readLock();
  if (!lock) return false;
  const url = lock.url;
  if (!(await probe(url)) && !pidAlive(lock.pid)) {
    // Dead claim, dead process; clear it so the next start is clean.
    rmSync(lockFile(), { force: true });
    return false;
  }
  await fetch(new URL("/quit", url), { method: "POST" });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!(await probe(url, 500))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The server at ${url} did not stop; kill pid ${readLock()?.pid ?? "?"} by hand.`);
}
