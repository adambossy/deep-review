import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssignedPr } from "@deep-review/pr";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddOptions, PrView } from "./registry.js";
import {
  planPoll,
  pollOnce,
  readWatcherState,
  watcherStateFile,
  writeWatcherState,
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
    writeWatcherState({ seen: { "acme/widgets#1": { updatedAt: "x", dispatchedAt: 1 } } });
    expect(readWatcherState().seen).toHaveProperty("acme/widgets#1");
  });
});
