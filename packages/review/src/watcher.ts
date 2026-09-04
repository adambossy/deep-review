/**
 * The watcher: the thing that notices a PR was assigned to you and hands it
 * to the server, so that a review is waiting rather than asked for.
 *
 * It polls rather than taking webhooks, because the machine it runs on is a
 * laptop that gets closed. A webhook delivered to a sleeping laptop is gone;
 * a poll asks GitHub for the *current* set of PRs assigned to you, so one
 * poll after the lid opens catches up on the whole night with no cursor
 * arithmetic, no public ingress, and nothing to replay. Missing a poll is
 * therefore uninteresting by construction — the next one subsumes it.
 *
 * What it polls is exactly the repos named in `watch.json`, each with its
 * own query; see `watchConfig.ts`. An empty or missing file means it watches
 * nothing, and says so. It never means "everything".
 *
 * State lives beside the server's, under `~/.deep-review` (or
 * $DEEP_REVIEW_HOME): one directory of truth even though the watcher and the
 * server are separate processes.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchPrInfo, listAssignedPrs, type AssignedPr, type PrRef } from "@deep-review/pr";
import { addPrToServer, ensureServer, findServer, removePrFromServer, stateDir } from "./daemon.js";
import { prKey, type AddOptions, type PrKey, type PrView } from "./registry.js";
import { readWatchConfig, watchConfigFile, type WatchedRepo } from "./watchConfig.js";

export function watcherStateFile(): string {
  return path.join(stateDir(), "watcher.json");
}

/** What the watcher remembers about a PR it has already handed over. */
export interface SeenPr {
  /** The PR's `updated_at` when we dispatched it; shown, not compared. */
  updatedAt: string;
  dispatchedAt: number;
}

export interface WatcherState {
  /**
   * PRs waiting on you that have been handed to the server, by
   * `owner/repo#number`. Bounded by the review query: a PR drops out of here
   * as soon as it leaves the query, whatever the reason.
   */
  seen: Record<PrKey, SeenPr>;
  /**
   * Every PR handed to the server that has not since been confirmed merged
   * or closed — the server's contents as far as the watcher knows. Unlike
   * `seen`, leaving the review query does not remove a PR from here: an
   * approved PR is still open, and a page for it is still worth keeping.
   * Absent in state files written before this field existed; `seen` is
   * folded in on read so those PRs are looked after too.
   */
  held: Record<PrKey, SeenPr>;
  /** The last poll that reached GitHub, for `status` to report. */
  lastPollAt?: number | undefined;
  /** Why the last poll failed, when it did; cleared by the next good one. */
  lastError?: string | undefined;
  /** The process running the loop, so `status` can tell whether one is. */
  runner?: { pid: number; startedAt: number } | undefined;
}

const EMPTY: WatcherState = { seen: {}, held: {} };

export function readWatcherState(): WatcherState {
  try {
    const parsed = JSON.parse(readFileSync(watcherStateFile(), "utf8")) as Partial<WatcherState>;
    const seen = parsed.seen ?? {};
    // Anything in `seen` was handed over, so it is held whether or not the
    // file knew to say so.
    return { ...EMPTY, ...parsed, seen, held: { ...seen, ...parsed.held } };
  } catch {
    // No file, or one we cannot read: an empty memory is the safe start —
    // the worst it costs is re-dispatching PRs the server already holds,
    // and adding a PR twice is idempotent there.
    return { ...EMPTY };
  }
}

export function writeWatcherState(state: WatcherState): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(watcherStateFile(), JSON.stringify(state, null, 2));
}

/** Is that pid still there? Signal 0 asks without sending anything. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which of the currently-assigned PRs to hand over, and what to remember.
 *
 * A PR is dispatched once, when it first appears assigned to you — not every
 * time it changes. `updated_at` moves on every comment and every push, and a
 * re-dispatch means a fresh slicing run, which costs a model call; reacting
 * to all of them would spend money on prose. Dropping PRs that are no longer
 * assigned both keeps the file bounded and gives unassign-then-reassign its
 * natural meaning: a deliberate way to ask for the review again.
 */
export function planPoll(
  assigned: AssignedPr[],
  seen: Record<PrKey, SeenPr>,
): { dispatch: AssignedPr[]; seen: Record<PrKey, SeenPr> } {
  const kept: Record<PrKey, SeenPr> = {};
  const dispatch: AssignedPr[] = [];
  for (const pr of assigned) {
    const key = prKey(pr);
    const already = seen[key];
    if (already) {
      kept[key] = already;
    } else {
      dispatch.push(pr);
      kept[key] = { updatedAt: pr.updatedAt, dispatchedAt: Date.now() };
    }
  }
  return { dispatch, seen: kept };
}

const PR_KEY = /^([^/]+)\/([^#]+)#(\d+)$/;

/** The `owner/repo#number` key back into a ref; null for a key not of that shape. */
export function parsePrKey(key: PrKey): PrRef | null {
  const match = PR_KEY.exec(key);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

/** What a merged-or-closed check needs to know about one PR. */
export interface PrLifecycle {
  state: "open" | "closed";
  merged: boolean;
}

/**
 * Which held PRs to stop holding: those GitHub confirms merged or closed.
 *
 * Leaving the review query is not the signal — it happens for approval, for
 * turning back into a draft, for unassignment, none of which finish the PR.
 * Only the PR's own state does, so each held PR that is no longer in the
 * query is asked about directly. The ones still in the query are open by the
 * query's own `is:open`, and are not asked about; that keeps this to a call
 * per PR that has gone quiet, not per PR per poll.
 *
 * A check that fails proves nothing either way, so the PR stays held and is
 * asked about again next poll; the worst case is a page that outlives its PR
 * by one GitHub hiccup, which is nothing against removing one still open.
 */
export async function planCleanup(
  held: Record<PrKey, SeenPr>,
  assigned: AssignedPr[],
  check: (ref: PrRef) => Promise<PrLifecycle>,
  log: (message: string) => void = () => {},
): Promise<{ finished: PrKey[]; held: Record<PrKey, SeenPr> }> {
  const inQuery = new Set(assigned.map(prKey));
  const finished: PrKey[] = [];
  const kept: Record<PrKey, SeenPr> = { ...held };
  for (const key of Object.keys(held)) {
    if (inQuery.has(key)) continue;
    const ref = parsePrKey(key);
    if (!ref) {
      // A key we cannot ask GitHub about cannot be confirmed finished.
      continue;
    }
    try {
      const pr = await check(ref);
      if (pr.state === "closed") {
        finished.push(key);
        delete kept[key];
        log(`${key}: ${pr.merged ? "merged" : "closed"}.`);
      }
    } catch (error) {
      log(`${key}: could not check — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { finished, held: kept };
}

export interface PollDeps {
  /**
   * The PRs waiting on you right now in one configured repo. Called once per
   * repo in `watch.json`, and for no other: a repo the file does not name is
   * never asked about.
   */
  list?: ((repo: WatchedRepo) => Promise<AssignedPr[]>) | undefined;
  /** The current state of one PR, for the merged-or-closed check. */
  check?: ((ref: PrRef) => Promise<PrLifecycle>) | undefined;
  /**
   * Drop one PR from the server. Defaults to asking a *running* server only:
   * one that is not up holds nothing, and starting it to delete from it would
   * be work for no one.
   */
  remove?: ((key: PrKey) => Promise<boolean>) | undefined;
  /** Hand one PR to the server. Defaults to starting/finding it and adding. */
  add?: ((pr: AssignedPr, options: AddOptions) => Promise<PrView>) | undefined;
  options?: AddOptions | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

/**
 * Hand each newly-assigned PR to the server, starting it if it is not up;
 * then take back from it each held PR that has since been merged or closed,
 * so the index shows what can still be acted on.
 *
 * The config file is read on every poll, so a repo added to it is watched
 * from the next check without restarting anything. With no repos there is
 * nothing to ask GitHub for new PRs about, and the poll says so; the held
 * PRs are still looked after, since they are on the server whatever the
 * file now says.
 *
 * The server is reached through the same `ensureServer` every CLI invocation
 * uses, so the watcher never "starts the daemon" as a separate step — it
 * asks for one the way anything else does, and a server that died overnight
 * simply comes back on the next assignment.
 */
export async function pollOnce(deps: PollDeps = {}): Promise<WatcherState> {
  const log = deps.onProgress ?? (() => {});
  const list =
    deps.list ?? ((repo: WatchedRepo) => listAssignedPrs({ repo: repo.repo, query: repo.query }));
  const before = readWatcherState();

  const config = readWatchConfig();
  for (const problem of config.problems) log(`${watchConfigFile()}: ${problem}`);
  if (config.repos.length === 0) {
    log(`Nothing to watch: ${watchConfigFile()} names no repos.`);
  }

  // One query per configured repo, and all or nothing: a repo whose query
  // failed would otherwise look emptied, and its PRs would fall out of
  // `seen` for a GitHub hiccup rather than for anything that happened.
  let assigned: AssignedPr[];
  try {
    assigned = [];
    for (const repo of config.repos) {
      assigned.push(...(await list(repo)));
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    log(`poll failed: ${why}`);
    const state = { ...before, lastError: why, lastPollAt: Date.now() };
    writeWatcherState(state);
    return state;
  }

  const { dispatch, seen } = planPoll(assigned, before.seen);
  if (config.repos.length > 0) {
    const repos = config.repos.length;
    log(
      `${assigned.length} PR${assigned.length === 1 ? "" : "s"} waiting ` +
        `across ${repos} repo${repos === 1 ? "" : "s"}; ${dispatch.length} new.`,
    );
  }

  // Note what is *not* set here: a workDir. The daemon keys one per PR
  // under the state dir, so it is already durable and already separate.
  // Pinning one here would put every clone and checkout in a single
  // directory, and builds run two at a time.
  const options: AddOptions = { ...deps.options };
  const add =
    deps.add ??
    (async (pr: AssignedPr, addOptions: AddOptions): Promise<PrView> => {
      const { url } = await ensureServer();
      return addPrToServer(
        url,
        { owner: pr.owner, repo: pr.repo, number: pr.number },
        addOptions,
      );
    });

  const dispatched: Record<PrKey, SeenPr> = { ...seen };
  const held: Record<PrKey, SeenPr> = { ...before.held };
  for (const pr of dispatch) {
    const key = prKey(pr);
    try {
      const view = await add(pr, options);
      held[key] = dispatched[key]!;
      log(`${key}: ${view.state}.`);
    } catch (error) {
      // Forget it, so the next poll tries again rather than losing the PR
      // to a server that happened to be down for this one minute.
      delete dispatched[key];
      log(`${key}: could not hand over — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Known, and separate: a PR that left `seen` for being approved comes back
  // into it — and re-dispatches — when a later review asks for changes.
  const cleanup = await planCleanup(held, assigned, deps.check ?? fetchPrInfo, log);
  const remove =
    deps.remove ??
    (async (key: PrKey): Promise<boolean> => {
      const url = await findServer();
      return url ? removePrFromServer(url, key) : false;
    });
  for (const key of cleanup.finished) {
    try {
      const removed = await remove(key);
      if (removed) log(`${key}: removed from the server.`);
    } catch (error) {
      // The PR is finished regardless; a server that would not answer is
      // either gone, and holds nothing, or will be asked about it by hand.
      log(`${key}: could not remove — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const state: WatcherState = {
    ...before,
    seen: dispatched,
    held: cleanup.held,
    lastPollAt: Date.now(),
    lastError: undefined,
  };
  writeWatcherState(state);
  return state;
}

export interface RunWatcherOptions {
  /** How long to wait between polls. */
  intervalMs?: number | undefined;
  onProgress?: ((message: string) => void) | undefined;
  /** Stop after this many polls; for tests, which cannot loop forever. */
  maxPolls?: number | undefined;
}

export const DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * Poll until stopped. Sleep is not handled specially: a timer that did not
 * fire while the lid was closed fires late, and the poll it belatedly runs
 * asks for the current set anyway, so the catch-up is the ordinary path.
 */
export async function runWatcher(options: RunWatcherOptions = {}): Promise<void> {
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = options.onProgress ?? (() => {});
  const state = readWatcherState();
  writeWatcherState({ ...state, runner: { pid: process.pid, startedAt: Date.now() } });

  const release = (): void => {
    const current = readWatcherState();
    if (current.runner?.pid === process.pid) {
      writeWatcherState({ ...current, runner: undefined });
    }
    process.exit(0);
  };
  process.once("SIGINT", release);
  process.once("SIGTERM", release);

  for (let polls = 0; options.maxPolls === undefined || polls < options.maxPolls; polls += 1) {
    await pollOnce({ onProgress: log });
    if (options.maxPolls !== undefined && polls + 1 >= options.maxPolls) break;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
