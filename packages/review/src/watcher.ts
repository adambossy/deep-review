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
 * State lives beside the server's, under `~/.deep-review` (or
 * $DEEP_REVIEW_HOME): one directory of truth even though the watcher and the
 * server are separate processes.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listAssignedPrs, prUrl, type AssignedPr } from "@deep-review/pr";
import { addPrToServer, ensureServer, stateDir } from "./daemon.js";
import { prKey, type AddOptions, type PrKey, type PrView } from "./registry.js";

export function watcherStateFile(): string {
  return path.join(stateDir(), "watcher.json");
}

/** Where an unattended watcher keeps clones, since the tmp dir gets purged. */
export function defaultWatcherWorkDir(): string {
  return path.join(stateDir(), "work");
}

/** What the watcher remembers about a PR it has already handed over. */
export interface SeenPr {
  /** The PR's `updated_at` when we dispatched it; shown, not compared. */
  updatedAt: string;
  dispatchedAt: number;
}

export interface WatcherState {
  /** PRs already handed to the server, by `owner/repo#number`. */
  seen: Record<PrKey, SeenPr>;
  /** The last poll that reached GitHub, for `status` to report. */
  lastPollAt?: number | undefined;
  /** Why the last poll failed, when it did; cleared by the next good one. */
  lastError?: string | undefined;
  /** The process running the loop, so `status` can tell whether one is. */
  runner?: { pid: number; startedAt: number } | undefined;
}

const EMPTY: WatcherState = { seen: {} };

export function readWatcherState(): WatcherState {
  try {
    const parsed = JSON.parse(readFileSync(watcherStateFile(), "utf8")) as WatcherState;
    return { ...EMPTY, ...parsed, seen: parsed.seen ?? {} };
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

export interface PollDeps {
  /** The PRs assigned to you right now. */
  list?: (() => Promise<AssignedPr[]>) | undefined;
  /** Hand one PR to the server. Defaults to starting/finding it and adding. */
  add?: ((pr: AssignedPr) => Promise<PrView>) | undefined;
  options?: AddOptions | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

/**
 * Hand each newly-assigned PR to the server, starting it if it is not up.
 *
 * The server is reached through the same `ensureServer` every CLI invocation
 * uses, so the watcher never "starts the daemon" as a separate step — it
 * asks for one the way anything else does, and a server that died overnight
 * simply comes back on the next assignment.
 */
export async function pollOnce(deps: PollDeps = {}): Promise<WatcherState> {
  const log = deps.onProgress ?? (() => {});
  const list = deps.list ?? listAssignedPrs;
  const before = readWatcherState();

  let assigned: AssignedPr[];
  try {
    assigned = await list();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    log(`poll failed: ${why}`);
    const state = { ...before, lastError: why, lastPollAt: Date.now() };
    writeWatcherState(state);
    return state;
  }

  const { dispatch, seen } = planPoll(assigned, before.seen);
  log(
    `${assigned.length} PR${assigned.length === 1 ? "" : "s"} assigned; ` +
      `${dispatch.length} new.`,
  );

  const add =
    deps.add ??
    (async (pr: AssignedPr): Promise<PrView> => {
      const { url } = await ensureServer();
      return addPrToServer(
        url,
        { owner: pr.owner, repo: pr.repo, number: pr.number, prUrl: prUrl(pr) },
        { workDir: defaultWatcherWorkDir(), ...deps.options },
      );
    });

  const dispatched: Record<PrKey, SeenPr> = { ...seen };
  for (const pr of dispatch) {
    const key = prKey(pr);
    try {
      const view = await add(pr);
      log(`${key}: ${view.state}.`);
    } catch (error) {
      // Forget it, so the next poll tries again rather than losing the PR
      // to a server that happened to be down for this one minute.
      delete dispatched[key];
      log(`${key}: could not hand over — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const state: WatcherState = {
    ...before,
    seen: dispatched,
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
