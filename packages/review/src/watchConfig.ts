/**
 * Which repos the watcher watches, and with what question.
 *
 * A file rather than a flag, because the answer is a list: each repo you
 * review for, with its own idea of what "waiting on me" means there. And a
 * list rather than a default, because the default used to be "every repo the
 * token can see", and one night that quietly handed six PRs from a personal
 * repo to the server. A repo is watched only by being named here. One that
 * is not named is never queried — not by fallback, not by omission.
 *
 * Lives under the state dir with `watcher.json` and `server.json`, so it
 * moves with $DEEP_REVIEW_HOME like everything else.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { namesRepo } from "@deep-review/pr";
import { stateDir } from "./daemon.js";

export function watchConfigFile(): string {
  return path.join(stateDir(), "watch.json");
}

/** One repo to watch, and the clauses to watch it with. */
export interface WatchedRepo {
  /** `owner/repo`; the search is always scoped to exactly this. */
  repo: string;
  /**
   * Filter clauses in GitHub search syntax, without `repo:` — the repo is
   * the key, and is appended for you. Absent means the default query.
   */
  query?: string | undefined;
}

/**
 * The file's shape. Keyed by `owner/repo` so the same repo cannot be listed
 * twice with two different queries, and so the entry with nothing to say
 * about its query is just `{}`: naming a repo is all it takes to watch it.
 *
 *   { "repos": { "acme/widgets": {}, "acme/gadgets": { "query": "..." } } }
 */
export interface WatchConfig {
  repos: Record<string, { query?: string | undefined }>;
}

export interface ParsedWatchConfig {
  repos: WatchedRepo[];
  /** Entries that were skipped, and why — for the log, not for a crash. */
  problems: string[];
}

const REPO_NAME = /^[^/\s]+\/[^/\s]+$/;

/**
 * Read one parsed JSON document into the list of repos to watch.
 *
 * Lenient about the parts that do not matter and strict about the one that
 * does: an entry that is not an object, or whose query is not a string, is
 * skipped with a note rather than taking the poll down with it; but a query
 * that names a repo is also skipped, because appended to the entry's own
 * `repo:` it would widen the search to both — the very leak this file
 * exists to prevent.
 */
export function parseWatchConfig(raw: unknown): ParsedWatchConfig {
  const problems: string[] = [];
  const repos: WatchedRepo[] = [];
  const doc = raw as Partial<WatchConfig> | null;
  const entries = doc && typeof doc === "object" ? doc.repos : undefined;
  if (entries === undefined) return { repos, problems };
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
    problems.push('"repos" should be an object keyed by owner/repo.');
    return { repos, problems };
  }
  for (const [repo, entry] of Object.entries(entries)) {
    if (!REPO_NAME.test(repo)) {
      problems.push(`${JSON.stringify(repo)} is not an owner/repo; skipped.`);
      continue;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${repo}: entry should be an object like {} or { "query": "..." }; skipped.`);
      continue;
    }
    const query = (entry as { query?: unknown }).query;
    if (query === undefined) {
      repos.push({ repo });
      continue;
    }
    if (typeof query !== "string" || query.trim() === "") {
      problems.push(`${repo}: "query" should be a non-empty string; skipped.`);
      continue;
    }
    if (namesRepo(query)) {
      problems.push(
        `${repo}: its query names a repo itself; the repo is the key, so leave repo: out. Skipped.`,
      );
      continue;
    }
    repos.push({ repo, query: query.trim() });
  }
  return { repos, problems };
}

/**
 * The repos to watch right now. No file is not an error: it means watch
 * nothing, and the caller says so. A file that will not parse is the same,
 * plus a note saying why — a watcher that crashed on a typo would be one
 * that stopped cleaning up after merged PRs too.
 */
export function readWatchConfig(): ParsedWatchConfig {
  const file = watchConfigFile();
  if (!existsSync(file)) return { repos: [], problems: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { repos: [], problems: [`${file} could not be read: ${why}`] };
  }
  return parseWatchConfig(raw);
}

/**
 * Name one more repo in the file, keeping everything already there. Used by
 * `watch --repo`, so the first repo takes one flag rather than an editor;
 * an entry already present keeps its query.
 */
export function addWatchedRepo(repo: string): { file: string; added: boolean } {
  const file = watchConfigFile();
  let doc: WatchConfig = { repos: {} };
  if (existsSync(file)) {
    // A file that will not parse is not rewritten: whatever it was trying to
    // say would be lost, and that is the user's to fix, not this flag's.
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<WatchConfig> | null;
    if (parsed && typeof parsed === "object" && parsed.repos && typeof parsed.repos === "object") {
      doc = { ...parsed, repos: { ...parsed.repos } };
    }
  }
  const added = !(repo in doc.repos);
  if (added) doc.repos[repo] = {};
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { file, added };
}

/** A starter file's contents, for the message that says where it goes. */
export function exampleWatchConfig(repo = "owner/repo"): string {
  return JSON.stringify({ repos: { [repo]: {} } }, null, 2);
}
