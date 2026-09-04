import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssignedPr, PrRef } from "@deep-review/pr";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddOptions, PrView } from "./registry.js";
import { watchConfigFile, type WatchConfig, type WatchedRepo } from "./watchConfig.js";
import {
  parsePrKey,
  planCleanup,
  planPoll,
  pollOnce,
  readWatcherState,
  watcherStateFile,
  writeWatcherState,
  type PrLifecycle,
  type SeenPr,
} from "./watcher.js";

function assigned(number: number, updatedAt = "2026-09-01T10:00:00Z"): AssignedPr {
  return {
    owner: "acme",
    repo: "widgets",
    number,
    title: `PR ${number}`,
    htmlUrl: `https://github.com/acme/widgets/pull/${number}`,
    updatedAt,
    draft: false,
  };
}

/** Name these repos in watch.json under the test's state dir. */
function watching(...repos: (string | [string, string])[]): void {
  const config: WatchConfig = { repos: {} };
  for (const entry of repos) {
    if (typeof entry === "string") config.repos[entry] = {};
    else config.repos[entry[0]] = { query: entry[1] };
  }
  mkdirSync(path.dirname(watchConfigFile()), { recursive: true });
  writeFileSync(watchConfigFile(), JSON.stringify(config));
}

function view(pr: AssignedPr): PrView {
  return {
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    prUrl: pr.htmlUrl,
    key: `${pr.owner}/${pr.repo}#${pr.number}`,
    state: "queued",
    path: `/pr/${pr.owner}/${pr.repo}/${pr.number}/`,
    addedAt: Date.now(),
    log: [],
    live: false,
  };
}

describe("planPoll", () => {
  it("dispatches a PR the first time it is seen", () => {
    const { dispatch, seen } = planPoll([assigned(1)], {});
    expect(dispatch.map((pr) => pr.number)).toEqual([1]);
    expect(Object.keys(seen)).toEqual(["acme/widgets#1"]);
  });

  it("does not dispatch again when the PR merely changed", () => {
    const before: Record<string, SeenPr> = {
      "acme/widgets#1": { updatedAt: "2026-09-01T10:00:00Z", dispatchedAt: 1 },
    };
    // A comment moves updated_at; re-slicing for that would cost a model call.
    const { dispatch, seen } = planPoll([assigned(1, "2026-09-02T18:00:00Z")], before);
    expect(dispatch).toEqual([]);
    expect(seen["acme/widgets#1"]).toEqual(before["acme/widgets#1"]);
  });

  it("forgets a PR that is no longer assigned, so reassigning asks again", () => {
    const before: Record<string, SeenPr> = {
      "acme/widgets#1": { updatedAt: "2026-09-01T10:00:00Z", dispatchedAt: 1 },
    };
    expect(planPoll([], before).seen).toEqual({});
    expect(planPoll([assigned(1)], planPoll([], before).seen).dispatch).toHaveLength(1);
  });

  it("dispatches only the new PR when others are already known", () => {
    const before = planPoll([assigned(1)], {}).seen;
    const { dispatch } = planPoll([assigned(1), assigned(2)], before);
    expect(dispatch.map((pr) => pr.number)).toEqual([2]);
  });
});

describe("pollOnce", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "watcher-test-"));
    process.env.DEEP_REVIEW_HOME = home;
    watching("acme/widgets");
  });

  afterEach(() => {
    delete process.env.DEEP_REVIEW_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("hands new PRs over and remembers them", async () => {
    const handed: number[] = [];
    const state = await pollOnce({
      list: async () => [assigned(1), assigned(2)],
      add: async (pr) => {
        handed.push(pr.number);
        return view(pr);
      },
    });
    expect(handed).toEqual([1, 2]);
    expect(Object.keys(state.seen)).toHaveLength(2);
    expect(readWatcherState().seen).toEqual(state.seen);
  });

  it("does not hand the same PR over twice across polls", async () => {
    const handed: number[] = [];
    const deps = {
      list: async () => [assigned(1)],
      add: async (pr: AssignedPr) => {
        handed.push(pr.number);
        return view(pr);
      },
    };
    await pollOnce(deps);
    await pollOnce(deps);
    expect(handed).toEqual([1]);
  });

  it("retries next poll when the handover failed", async () => {
    let attempts = 0;
    const deps = {
      list: async () => [assigned(1)],
      add: async (pr: AssignedPr) => {
        attempts += 1;
        if (attempts === 1) throw new Error("server down");
        return view(pr);
      },
    };
    const first = await pollOnce(deps);
    // A PR lost to one bad minute must not be remembered as delivered.
    expect(first.seen).toEqual({});
    await pollOnce(deps);
    expect(attempts).toBe(2);
    expect(Object.keys(readWatcherState().seen)).toEqual(["acme/widgets#1"]);
  });

  it("keeps what it knew when GitHub cannot be reached", async () => {
    await pollOnce({ list: async () => [assigned(1)], add: async (pr) => view(pr) });
    const state = await pollOnce({
      list: async () => {
        throw new Error("offline");
      },
    });
    expect(state.lastError).toBe("offline");
    expect(Object.keys(state.seen)).toEqual(["acme/widgets#1"]);
  });

  it("writes state as readable JSON under the state dir", async () => {
    await pollOnce({ list: async () => [assigned(7)], add: async (pr) => view(pr) });
    expect(watcherStateFile()).toBe(path.join(home, "watcher.json"));
    expect(JSON.parse(readFileSync(watcherStateFile(), "utf8")).seen).toHaveProperty(
      "acme/widgets#7",
    );
  });

  it("leaves the work dir to the daemon, which keys one per PR", async () => {
    // A single shared work dir would put the clones and checkouts of two
    // concurrently building PRs on top of each other.
    let handed: AddOptions | undefined;
    await pollOnce({
      list: async () => [assigned(1)],
      add: async (pr, options) => {
        handed = options;
        return view(pr);
      },
    });
    expect(handed).toBeDefined();
    expect(handed).not.toHaveProperty("workDir");
  });

  it("survives a corrupt state file rather than refusing to start", () => {
    writeWatcherState({
      seen: { "acme/widgets#1": { updatedAt: "x", dispatchedAt: 1 } },
      held: {},
    });
    expect(readWatcherState().seen).toHaveProperty("acme/widgets#1");
  });

  it("reads a state file written before `held` existed, and holds what it saw", () => {
    // There is a live watcher.json on any machine that ran the watcher before
    // this field; it must load, and the PRs it had handed over must be looked
    // after — they are on the server, and only `seen` knows it.
    mkdirSync(home, { recursive: true });
    writeFileSync(
      watcherStateFile(),
      JSON.stringify({
        seen: { "acme/widgets#1": { updatedAt: "x", dispatchedAt: 1 } },
        lastPollAt: 5,
      }),
    );
    const state = readWatcherState();
    expect(Object.keys(state.held)).toEqual(["acme/widgets#1"]);
    expect(state.seen).toEqual(state.held);
    expect(state.lastPollAt).toBe(5);
  });
});

describe("parsePrKey", () => {
  it("turns a key back into the ref that made it", () => {
    expect(parsePrKey("acme/widgets#12")).toEqual({ owner: "acme", repo: "widgets", number: 12 });
  });

  it("refuses a key of another shape rather than guessing", () => {
    expect(parsePrKey("nonsense")).toBeNull();
  });
});

const OPEN: PrLifecycle = { state: "open", merged: false };
const MERGED: PrLifecycle = { state: "closed", merged: true };
const CLOSED: PrLifecycle = { state: "closed", merged: false };

function heldPr(): SeenPr {
  return { updatedAt: "2026-09-01T10:00:00Z", dispatchedAt: 1 };
}

describe("planCleanup", () => {
  it("finishes a held PR that has been merged", async () => {
    const { finished, held } = await planCleanup(
      { "acme/widgets#1": heldPr() },
      [],
      async () => MERGED,
    );
    expect(finished).toEqual(["acme/widgets#1"]);
    expect(held).toEqual({});
  });

  it("finishes a held PR that was closed without merging", async () => {
    // Closed-unmerged is as done as merged: nothing on that page is going in.
    const { finished } = await planCleanup({ "acme/widgets#1": heldPr() }, [], async () => CLOSED);
    expect(finished).toEqual(["acme/widgets#1"]);
  });

  it("keeps a PR that left the review query but is still open", async () => {
    // Approval removes a PR from the query, and so does unassigning it or
    // turning it back into a draft; none of those finish it. Only GitHub's
    // own state may, so a PR that is gone from the query yet still open stays.
    const { finished, held } = await planCleanup(
      { "acme/widgets#1": heldPr() },
      [],
      async () => OPEN,
    );
    expect(finished).toEqual([]);
    expect(Object.keys(held)).toEqual(["acme/widgets#1"]);
  });

  it("does not ask about PRs the query still lists, which are open by definition", async () => {
    const asked: PrRef[] = [];
    await planCleanup({ "acme/widgets#1": heldPr(), "acme/widgets#2": heldPr() }, [assigned(1)], async (ref) => {
      asked.push(ref);
      return OPEN;
    });
    expect(asked.map((ref) => ref.number)).toEqual([2]);
  });

  it("keeps a PR whose check failed, and finishes the others", async () => {
    // A failed check proves nothing either way; the safe reading is "still
    // open", and the next poll asks again.
    const { finished, held } = await planCleanup(
      { "acme/widgets#1": heldPr(), "acme/widgets#2": heldPr() },
      [],
      async (ref) => {
        if (ref.number === 1) throw new Error("502");
        return MERGED;
      },
    );
    expect(finished).toEqual(["acme/widgets#2"]);
    expect(Object.keys(held)).toEqual(["acme/widgets#1"]);
  });
});

describe("pollOnce cleanup", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "watcher-test-"));
    process.env.DEEP_REVIEW_HOME = home;
    watching("acme/widgets");
  });

  afterEach(() => {
    delete process.env.DEEP_REVIEW_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  /** Hand PR 1 over on one poll, so a later poll has something to clean up. */
  async function handOver(): Promise<void> {
    await pollOnce({
      list: async () => [assigned(1)],
      add: async (pr) => view(pr),
      check: async () => OPEN,
    });
    expect(Object.keys(readWatcherState().held)).toEqual(["acme/widgets#1"]);
  }

  it("removes a merged PR from the server and forgets it", async () => {
    await handOver();
    const removed: string[] = [];
    const state = await pollOnce({
      list: async () => [],
      check: async () => MERGED,
      remove: async (key) => {
        removed.push(key);
        return true;
      },
    });
    expect(removed).toEqual(["acme/widgets#1"]);
    expect(state.held).toEqual({});
    expect(state.seen).toEqual({});
    expect(readWatcherState().held).toEqual({});
  });

  it("removes a PR closed without merging", async () => {
    await handOver();
    const removed: string[] = [];
    await pollOnce({
      list: async () => [],
      check: async () => CLOSED,
      remove: async (key) => {
        removed.push(key);
        return true;
      },
    });
    expect(removed).toEqual(["acme/widgets#1"]);
  });

  it("leaves an approved PR on the server, held, though it left the query", async () => {
    await handOver();
    const removed: string[] = [];
    const state = await pollOnce({
      list: async () => [],
      check: async () => OPEN,
      remove: async (key) => {
        removed.push(key);
        return true;
      },
    });
    expect(removed).toEqual([]);
    // Out of `seen` — the query no longer lists it — but still held.
    expect(state.seen).toEqual({});
    expect(Object.keys(state.held)).toEqual(["acme/widgets#1"]);
  });

  it("neither crashes nor removes anything when the check errors", async () => {
    await handOver();
    const removed: string[] = [];
    const state = await pollOnce({
      list: async () => [],
      check: async () => {
        throw new Error("GitHub 502");
      },
      remove: async (key) => {
        removed.push(key);
        return true;
      },
    });
    expect(removed).toEqual([]);
    expect(Object.keys(state.held)).toEqual(["acme/widgets#1"]);
    expect(state.lastError).toBeUndefined();
  });

  it("still forgets a finished PR when the server could not be told", async () => {
    // The server's registry is in memory: one that is not running holds
    // nothing, and one that will not answer is not this poll's to fix.
    await handOver();
    const state = await pollOnce({
      list: async () => [],
      check: async () => MERGED,
      remove: async () => {
        throw new Error("connection refused");
      },
    });
    expect(state.held).toEqual({});
  });

  it("does not hold a PR whose handover failed", async () => {
    // Nothing reached the server, so there is nothing there to clean up.
    const state = await pollOnce({
      list: async () => [assigned(1)],
      add: async () => {
        throw new Error("server down");
      },
      check: async () => OPEN,
    });
    expect(state.held).toEqual({});
  });
});

describe("pollOnce across repos", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "watcher-test-"));
    process.env.DEEP_REVIEW_HOME = home;
  });

  afterEach(() => {
    delete process.env.DEEP_REVIEW_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  function inRepo(repo: string, number: number): AssignedPr {
    const [owner, name] = repo.split("/") as [string, string];
    return { ...assigned(number), owner, repo: name, htmlUrl: `https://github.com/${repo}/pull/${number}` };
  }

  /** A fake GitHub holding PRs for several repos, remembering what it was asked. */
  function github(prs: Record<string, AssignedPr[]>) {
    const asked: WatchedRepo[] = [];
    const list = async (repo: WatchedRepo): Promise<AssignedPr[]> => {
      asked.push(repo);
      return prs[repo.repo] ?? [];
    };
    return { asked, list };
  }

  it("polls each configured repo with its own query and holds PRs from all of them", async () => {
    watching(["acme/widgets", "is:open is:pr review-requested:@me"], ["acme/gadgets", "is:open is:pr label:needs-review"]);
    const gh = github({
      "acme/widgets": [inRepo("acme/widgets", 1)],
      "acme/gadgets": [inRepo("acme/gadgets", 9)],
    });
    const handed: string[] = [];
    const state = await pollOnce({
      list: gh.list,
      add: async (pr) => {
        handed.push(`${pr.owner}/${pr.repo}#${pr.number}`);
        return view(pr);
      },
      check: async () => OPEN,
    });
    expect(gh.asked).toEqual([
      { repo: "acme/widgets", query: "is:open is:pr review-requested:@me" },
      { repo: "acme/gadgets", query: "is:open is:pr label:needs-review" },
    ]);
    expect(handed.sort()).toEqual(["acme/gadgets#9", "acme/widgets#1"]);
    expect(Object.keys(state.seen).sort()).toEqual(["acme/gadgets#9", "acme/widgets#1"]);
    expect(Object.keys(state.held).sort()).toEqual(["acme/gadgets#9", "acme/widgets#1"]);
  });

  it("never asks about a repo the file does not name", async () => {
    // The incident this file exists for: with no repo configured, the old
    // watcher asked for every PR the token could see, and six from a
    // personal repo nobody meant to watch landed on the server. Now a repo
    // is queried only by being named — the fake GitHub has PRs waiting in
    // adambossy/panoply, and is never asked for them.
    watching("acme/widgets");
    const gh = github({
      "acme/widgets": [inRepo("acme/widgets", 1)],
      "adambossy/panoply": [inRepo("adambossy/panoply", 3), inRepo("adambossy/panoply", 4)],
    });
    const handed: string[] = [];
    const state = await pollOnce({
      list: gh.list,
      add: async (pr) => {
        handed.push(`${pr.owner}/${pr.repo}#${pr.number}`);
        return view(pr);
      },
      check: async () => OPEN,
    });
    expect(gh.asked.map((repo) => repo.repo)).toEqual(["acme/widgets"]);
    expect(handed).toEqual(["acme/widgets#1"]);
    expect(Object.keys(state.held)).toEqual(["acme/widgets#1"]);
  });

  it("uses the default query for a repo that names none", async () => {
    // Opting a repo in should take nothing but its name; the query is the
    // library's business unless the entry says otherwise.
    watching("acme/widgets");
    const gh = github({});
    await pollOnce({ list: gh.list, check: async () => OPEN });
    expect(gh.asked).toEqual([{ repo: "acme/widgets" }]);
  });

  it("polls nothing, and says so, when there is no config file", async () => {
    // Not an error: a fresh install has no file. But not silence either,
    // and above all not "everything" — the absence of a scope used to mean
    // the widest one, and that is the reading this removes.
    const gh = github({ "adambossy/panoply": [inRepo("adambossy/panoply", 3)] });
    const messages: string[] = [];
    const state = await pollOnce({ list: gh.list, onProgress: (m) => messages.push(m) });
    expect(gh.asked).toEqual([]);
    expect(messages.join("\n")).toMatch(/Nothing to watch/);
    expect(messages.join("\n")).toContain(watchConfigFile());
    expect(state.lastError).toBeUndefined();
    expect(state.seen).toEqual({});
  });

  it("polls nothing, and says so, when the file lists no repos", async () => {
    writeFileSync(watchConfigFile(), JSON.stringify({ repos: {} }));
    const gh = github({ "adambossy/panoply": [inRepo("adambossy/panoply", 3)] });
    const messages: string[] = [];
    await pollOnce({ list: gh.list, onProgress: (m) => messages.push(m) });
    expect(gh.asked).toEqual([]);
    expect(messages.join("\n")).toMatch(/Nothing to watch/);
  });

  it("survives a corrupt config file, watching nothing and saying why", async () => {
    // A typo in the file must not take the watcher down: a crashed watcher
    // also stops removing merged PRs from the server. And it must not be
    // read as "no scope", which used to mean the widest scope.
    writeFileSync(watchConfigFile(), "{ this is not json");
    const gh = github({ "adambossy/panoply": [inRepo("adambossy/panoply", 3)] });
    const messages: string[] = [];
    const state = await pollOnce({ list: gh.list, onProgress: (m) => messages.push(m) });
    expect(gh.asked).toEqual([]);
    expect(messages.join("\n")).toMatch(/could not be read/);
    expect(state.lastError).toBeUndefined();
  });

  it("skips a repo whose query names a repo, and polls the rest", async () => {
    // A second repo: qualifier widens a GitHub search rather than narrowing
    // it, so an entry that carries one could reach into a repo the file
    // never named. It is left out, with a note, and the others go ahead.
    watching(["acme/widgets", "is:open repo:adambossy/panoply"], "acme/gadgets");
    const gh = github({});
    const messages: string[] = [];
    await pollOnce({ list: gh.list, onProgress: (m) => messages.push(m) });
    expect(gh.asked.map((repo) => repo.repo)).toEqual(["acme/gadgets"]);
    expect(messages.join("\n")).toMatch(/acme\/widgets: its query names a repo/);
  });

  it("keeps what it knew when one repo's query fails, rather than emptying that repo", async () => {
    // Partial results would make the failed repo look emptied: its PRs would
    // leave `seen` for a GitHub hiccup, then re-dispatch when it came back.
    watching("acme/widgets", "acme/gadgets");
    await pollOnce({
      list: async (repo) => (repo.repo === "acme/widgets" ? [inRepo("acme/widgets", 1)] : []),
      add: async (pr) => view(pr),
      check: async () => OPEN,
    });
    const state = await pollOnce({
      list: async (repo) => {
        if (repo.repo === "acme/gadgets") throw new Error("422");
        return [inRepo("acme/widgets", 1)];
      },
    });
    expect(state.lastError).toBe("422");
    expect(Object.keys(state.seen)).toEqual(["acme/widgets#1"]);
  });

  it("still cleans up held PRs when the file has since been emptied", async () => {
    // A PR handed over is on the server whatever the file now says; taking
    // its repo out of the file should not strand its page there forever.
    watching("acme/widgets");
    await pollOnce({
      list: async () => [inRepo("acme/widgets", 1)],
      add: async (pr) => view(pr),
      check: async () => OPEN,
    });
    writeFileSync(watchConfigFile(), JSON.stringify({ repos: {} }));
    const removed: string[] = [];
    const state = await pollOnce({
      check: async () => MERGED,
      remove: async (key) => {
        removed.push(key);
        return true;
      },
    });
    expect(removed).toEqual(["acme/widgets#1"]);
    expect(state.held).toEqual({});
  });
});
