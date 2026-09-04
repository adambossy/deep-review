/**
 * The set of PRs one navigation server holds, and the lifecycle of each.
 *
 * A PR arrives as a URL and nothing else. Slicing it and walking its call
 * graphs is slow — a paid model call, then a language service over a whole
 * checkout — so a PR is added at once and built in the background, a few at
 * a time; the page for it says "building" until it is ready. Once built, its
 * language services are started only when a reader first clicks a symbol,
 * and let go again when the page goes away or the entry sits idle, because
 * a session is fully derivable from what was built and cheap to recreate.
 */

import {
  fragmentSize,
  NavSession,
  type SizeBreakdown,
  type SliceExplorerInput,
} from "@deep-review/call-graph";
import { prUrl, type PrRef } from "@deep-review/pr";

export type { PrRef } from "@deep-review/pr";

/** A PR's identity across everything here: `owner/repo#number`. */
export type PrKey = string;

export function prKey(ref: PrRef): PrKey {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/** Where a PR's page and its navigation endpoints are mounted, with a trailing slash. */
export function prMountPath(ref: PrRef): string {
  return `/pr/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${ref.number}/`;
}

/**
 * The parse half of `prMountPath`: which PR a request path names, and the
 * rest of the path under its prefix. `/pr/vercel/swr/2950/panel` → that PR,
 * `/panel`. Null for paths that are not under a PR prefix — including a
 * malformed percent-escape, which is a bad address, not a server fault.
 */
export interface PrRoute {
  ref: PrRef;
  key: PrKey;
  rest: string;
  /** The request pointed at the PR itself without a trailing slash. */
  needsSlash: boolean;
  mount: string;
}

export function parsePrPath(pathname: string): PrRoute | null {
  const parts = pathname.split("/").filter((p) => p !== "");
  if (parts.length < 4 || parts[0] !== "pr") return null;
  let owner: string;
  let repo: string;
  try {
    owner = decodeURIComponent(parts[1]!);
    repo = decodeURIComponent(parts[2]!);
  } catch {
    return null;
  }
  const number = Number(parts[3]);
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) return null;
  const ref = { owner, repo, number };
  return {
    ref,
    key: prKey(ref),
    rest: `/${parts.slice(4).join("/")}`,
    needsSlash: parts.length === 4 && !pathname.endsWith("/"),
    mount: prMountPath(ref),
  };
}

/**
 * How far along a PR is. `queued` and `building` both mean the page is not
 * there yet; `failed` is terminal until the PR is added again, and keeps the
 * reason so the index can show it rather than a blank row.
 */
export type PrState = "queued" | "building" | "ready" | "failed";

/** What a PR looks like from outside: the index page and `/prs` both read this. */
export interface PrView extends PrRef {
  prUrl: string;
  key: PrKey;
  state: PrState;
  /** Mount path, so a caller can build the page URL without knowing the scheme. */
  path: string;
  title?: string | undefined;
  slices?: number | undefined;
  /** Slices that got a walkable call graph. */
  graphs?: number | undefined;
  /** The PR's +/− lines, split core / tests / boilerplate when the slicer classified them. */
  size?: SizeBreakdown | undefined;
  /** Why the build failed, when it did. */
  error?: string | undefined;
  addedAt: number;
  readyAt?: number | undefined;
  /** The head commit the build was made from, for staleness checks. */
  headSha?: string | undefined;
  /** The build's progress lines, newest last — what the index shows while building. */
  log: string[];
  /** Whether language services are up for this PR right now. */
  live: boolean;
}

/** What a build produced: enough to render the page and answer about symbols. */
export interface BuiltPr {
  input: SliceExplorerInput;
  /** The PR's head checkout, which the language services read. */
  headDir: string;
  html: string;
  /** The head commit this build was made from; a moved head means a stale build. */
  headSha?: string | undefined;
}

/** Per-PR knobs, carried from the request that added it. */
export interface AddOptions {
  /** Reuse a saved slice JSON instead of paying for a fresh slicing run. */
  slicesFile?: string | undefined;
  /** Also write this run's slice JSON here. */
  save?: string | undefined;
  model?: string | undefined;
  maxGraphs?: number | undefined;
  debugMarks?: boolean | undefined;
  workDir?: string | undefined;
}

/**
 * Turns a PR into a built page. Injected rather than imported so the
 * registry's lifecycle can be tested without a model call or a checkout.
 */
export type BuildPr = (
  request: { prUrl: string; navBase: string; options: AddOptions },
  log: (message: string) => void,
) => Promise<BuiltPr>;

export interface RegistryOptions {
  build: BuildPr;
  /** How many PRs may build at once. Slicing and graph analysis are both heavy. */
  concurrency?: number | undefined;
  /**
   * How long after a page says it is gone the language services are let go.
   * A reload says goodbye before the new page says hello, so this is the
   * window in which the new page can cancel the goodbye.
   */
  sessionGraceMs?: number | undefined;
  /** Let a session go after this long with no question asked of it. */
  sessionIdleMs?: number | undefined;
  /** Progress lines kept per PR; the oldest are dropped past this. */
  logLimit?: number | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

interface Entry extends PrRef {
  prUrl: string;
  key: PrKey;
  state: PrState;
  options: AddOptions;
  addedAt: number;
  readyAt?: number;
  error?: string;
  log: string[];
  built?: BuiltPr;
  session?: NavSession;
  /** When a question was last asked of this PR's session. */
  lastUsed: number;
  /** Pending "the page is gone, let the session go" timer. */
  release?: NodeJS.Timeout;
}

const DEFAULTS = {
  concurrency: 2,
  sessionGraceMs: 3000,
  sessionIdleMs: 15 * 60 * 1000,
  logLimit: 200,
};

export class PrRegistry {
  private readonly entries = new Map<PrKey, Entry>();
  private readonly build: BuildPr;
  private readonly concurrency: number;
  private readonly sessionGraceMs: number;
  private readonly sessionIdleMs: number;
  private readonly logLimit: number;
  private readonly log: (message: string) => void;
  /** Keys waiting for a build slot, in the order they were added. */
  private readonly queue: PrKey[] = [];
  private building = 0;
  private sweep: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(options: RegistryOptions) {
    this.build = options.build;
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULTS.concurrency);
    this.sessionGraceMs = options.sessionGraceMs ?? DEFAULTS.sessionGraceMs;
    this.sessionIdleMs = options.sessionIdleMs ?? DEFAULTS.sessionIdleMs;
    this.logLimit = options.logLimit ?? DEFAULTS.logLimit;
    this.log = options.onProgress ?? (() => {});
    // An idle session is worth reclaiming but not worth watching closely;
    // a sweep at a fraction of the idle window is close enough.
    if (this.sessionIdleMs > 0) {
      this.sweep = setInterval(
        () => this.releaseIdle(),
        Math.max(1000, Math.floor(this.sessionIdleMs / 4)),
      );
      this.sweep.unref();
    }
  }

  /**
   * Add a PR, or return the one already here. Adding a PR that failed
   * retries it; adding one that is queued, building or ready is a no-op, so
   * a reader who runs the same command twice gets the same page rather than
   * a second slicing run.
   */
  add(ref: PrRef, options: AddOptions = {}): PrView {
    const key = prKey(ref);
    const existing = this.entries.get(key);
    if (existing && existing.state !== "failed") return this.view(existing);

    const entry: Entry = {
      ...ref,
      prUrl: prUrl(ref),
      key,
      state: "queued",
      options,
      addedAt: Date.now(),
      log: [],
      lastUsed: Date.now(),
    };
    this.entries.set(key, entry);
    this.queue.push(key);
    this.pump();
    return this.view(entry);
  }

  get(key: PrKey): PrView | null {
    const entry = this.entries.get(key);
    return entry ? this.view(entry) : null;
  }

  list(): PrView[] {
    return [...this.entries.values()]
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((e) => this.view(e));
  }

  /** How many PRs are held, without building a view of each. */
  count(): number {
    return this.entries.size;
  }

  /** The rendered page, or null while the PR is not ready. */
  html(key: PrKey): string | null {
    return this.entries.get(key)?.built?.html ?? null;
  }

  /**
   * This PR's language services, started on the first question asked of it.
   * Null when the PR is not built yet — there is nothing to be warm over.
   */
  sessionFor(key: PrKey): NavSession | null {
    const entry = this.entries.get(key);
    if (!entry?.built) return null;
    entry.lastUsed = Date.now();
    if (entry.release) {
      clearTimeout(entry.release);
      delete entry.release;
    }
    if (!entry.session) {
      this.log(`${key}: starting language services.`);
      entry.session = new NavSession(entry.built.headDir, entry.built.input, {
        debug: entry.built.input.debugMarks,
      });
      entry.session.warm();
    }
    return entry.session;
  }

  /** The page for this PR loaded: it is here, so nothing pending applies. */
  pageAlive(key: PrKey): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.lastUsed = Date.now();
    if (entry.release) {
      clearTimeout(entry.release);
      delete entry.release;
    }
  }

  /**
   * The page for this PR went away. Its language services are let go after
   * the grace window — the server itself stays up for every other PR.
   */
  pageGone(key: PrKey): void {
    const entry = this.entries.get(key);
    if (!entry || !entry.session) return;
    if (entry.release) clearTimeout(entry.release);
    entry.release = setTimeout(() => {
      delete entry.release;
      this.releaseSession(entry, "page closed");
    }, this.sessionGraceMs);
  }

  /** Drop a PR entirely: its session, its build, its place in the list. */
  remove(key: PrKey): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.release) clearTimeout(entry.release);
    this.releaseSession(entry, "removed");
    const queued = this.queue.indexOf(key);
    if (queued !== -1) this.queue.splice(queued, 1);
    this.entries.delete(key);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    for (const entry of this.entries.values()) {
      if (entry.release) clearTimeout(entry.release);
      this.releaseSession(entry, "shutting down");
    }
  }

  /** Resolves once nothing is queued or building. Tests and `--wait` use it. */
  async settled(): Promise<void> {
    while (this.building > 0 || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private releaseSession(entry: Entry, why: string): void {
    if (!entry.session) return;
    entry.session.dispose();
    delete entry.session;
    this.log(`${entry.key}: language services let go (${why}).`);
  }

  private releaseIdle(): void {
    const cutoff = Date.now() - this.sessionIdleMs;
    for (const entry of this.entries.values()) {
      if (entry.session && entry.lastUsed < cutoff) {
        this.releaseSession(entry, "idle");
      }
    }
  }

  /** Start as many queued builds as the concurrency limit allows. */
  private pump(): void {
    while (!this.disposed && this.building < this.concurrency && this.queue.length > 0) {
      const key = this.queue.shift()!;
      const entry = this.entries.get(key);
      // Removed while it waited for a slot.
      if (!entry || entry.state !== "queued") continue;
      this.building++;
      void this.run(entry).finally(() => {
        this.building--;
        this.pump();
      });
    }
  }

  private async run(entry: Entry): Promise<void> {
    entry.state = "building";
    const note = (message: string): void => {
      entry.log.push(message);
      if (entry.log.length > this.logLimit) entry.log.shift();
      this.log(`${entry.key}: ${message}`);
    };
    try {
      const built = await this.build(
        {
          prUrl: entry.prUrl,
          navBase: prMountPath(entry),
          options: entry.options,
        },
        note,
      );
      // Removed while it built: throw the work away rather than resurrect it.
      if (!this.entries.has(entry.key)) return;
      entry.built = built;
      entry.state = "ready";
      entry.readyAt = Date.now();
      delete entry.error;
      note(
        `ready — ${built.input.slices.length} slices, ${built.input.slices.filter((s) => s.graph).length} with a walkable call graph.`,
      );
    } catch (error) {
      if (!this.entries.has(entry.key)) return;
      entry.state = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
      note(`failed — ${entry.error}`);
    }
  }

  private view(entry: Entry): PrView {
    const input = entry.built?.input;
    return {
      key: entry.key,
      owner: entry.owner,
      repo: entry.repo,
      number: entry.number,
      prUrl: entry.prUrl,
      state: entry.state,
      path: prMountPath(entry),
      ...(input?.prTitle ? { title: input.prTitle } : {}),
      ...(input ? { slices: input.slices.length } : {}),
      ...(input ? { graphs: input.slices.filter((s) => s.graph).length } : {}),
      ...(input ? { size: fragmentSize(input.slices.flatMap((s) => s.fragments)) } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      addedAt: entry.addedAt,
      ...(entry.readyAt !== undefined ? { readyAt: entry.readyAt } : {}),
      ...(entry.built?.headSha ? { headSha: entry.built.headSha } : {}),
      log: [...entry.log],
      live: entry.session !== undefined,
    };
  }
}
