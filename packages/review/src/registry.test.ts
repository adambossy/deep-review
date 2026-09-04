import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SliceExplorerInput } from "@deep-review/call-graph";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePrPath, PrRegistry, prKey, prMountPath, type BuiltPr, type PrRef } from "./registry.js";

const headDir = mkdtempSync(path.join(os.tmpdir(), "registry-test-"));
afterAll(() => rmSync(headDir, { recursive: true, force: true }));

function ref(number: number): PrRef {
  return { owner: "a", repo: "b", number };
}

/** The URL the registry derives for `ref(n)` — what the build fn is keyed by. */
function urlOf(number: number): string {
  return `https://github.com/a/b/pull/${number}`;
}

function built(number: number, navBase: string): BuiltPr {
  const input: SliceExplorerInput = {
    prUrl: `https://github.com/a/b/pull/${number}`,
    prTitle: `PR ${number}`,
    repo: "a/b",
    number,
    overview: "o",
    files: [],
    slices: [],
    navBase,
  };
  return { input, headDir, html: `<html>${number}</html>` };
}

/** A build the test controls: it finishes when told to, or fails. */
function manualBuild() {
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  const build = ({ prUrl, navBase }: { prUrl: string; navBase: string }) =>
    new Promise<BuiltPr>((resolve, reject) => {
      const number = Number(prUrl.split("/").pop());
      pending.set(prUrl, {
        resolve: () => resolve(built(number, navBase)),
        reject,
      });
    });
  return { build, pending };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("PrRegistry", () => {
  it("names a PR's key and mount stably, and parses its own mount back", () => {
    expect(prKey(ref(7))).toBe("a/b#7");
    expect(prMountPath(ref(7))).toBe("/pr/a/b/7/");
    // The codec pair roundtrips, so the builder and parser cannot drift.
    const spiky: PrRef = { owner: "we ird", repo: "re/po", number: 12 };
    const route = parsePrPath(prMountPath(spiky));
    expect(route?.ref).toEqual(spiky);
    expect(route?.rest).toBe("/");
    expect(parsePrPath(`${prMountPath(spiky)}panel`)?.rest).toBe("/panel");
    expect(parsePrPath("/pr/%zz/b/1/")).toBeNull();
    expect(parsePrPath("/elsewhere")).toBeNull();
  });

  it("builds what it is given, at most `concurrency` at a time, in order", async () => {
    const { build, pending } = manualBuild();
    const registry = new PrRegistry({ build, concurrency: 2 });
    registry.add(ref(1));
    registry.add(ref(2));
    registry.add(ref(3));
    await tick();
    // Two slots: 1 and 2 build, 3 waits.
    expect(registry.list().map((p) => p.state)).toEqual(["building", "building", "queued"]);
    pending.get(urlOf(1))!.resolve();
    await tick();
    expect(registry.get("a/b#1")?.state).toBe("ready");
    expect(registry.get("a/b#3")?.state).toBe("building");
    expect(registry.html("a/b#1")).toBe("<html>1</html>");
    // The build was told where its page will live.
    expect(registry.get("a/b#1")?.path).toBe("/pr/a/b/1/");
    pending.get(urlOf(2))!.resolve();
    pending.get(urlOf(3))!.resolve();
    await registry.settled();
    registry.dispose();
  });

  it("adds idempotently, but retries a failure", async () => {
    const { build, pending } = manualBuild();
    const registry = new PrRegistry({ build });
    registry.add(ref(1));
    registry.add(ref(1));
    await tick();
    expect(registry.list()).toHaveLength(1);
    pending.get(urlOf(1))!.reject(new Error("no key"));
    await registry.settled();
    expect(registry.get("a/b#1")).toMatchObject({ state: "failed", error: "no key" });

    pending.delete(urlOf(1));
    registry.add(ref(1));
    await tick();
    expect(registry.get("a/b#1")?.state).toBe("building");
    pending.get(urlOf(1))!.resolve();
    await registry.settled();
    expect(registry.get("a/b#1")?.state).toBe("ready");
    registry.dispose();
  });

  it("keeps a build log per PR and reports it in the view", async () => {
    const registry = new PrRegistry({
      build: (_request, log) => {
        log("first");
        log("second");
        return Promise.resolve(built(1, "/pr/a/b/1/"));
      },
    });
    registry.add(ref(1));
    await registry.settled();
    const view = registry.get("a/b#1")!;
    expect(view.log.slice(0, 2)).toEqual(["first", "second"]);
    expect(view.log[view.log.length - 1]).toContain("ready");
    registry.dispose();
  });

  it("sizes a built PR from its fragments, split by kind", async () => {
    const registry = new PrRegistry({
      build: () => {
        const b = built(1, "/pr/a/b/1/");
        const fragment = {
          id: "f",
          file: "a.ts",
          summary: "s",
          hunkHeader: "@@",
          newLineNumbers: [1],
          headStart: 1,
          headEnd: 1,
        };
        b.input.slices = [
          {
            id: "slice-1",
            title: "t",
            summary: "s",
            rationale: "r",
            fragments: [
              { ...fragment, kind: "core", lines: ["+a", "-b"] },
              { ...fragment, kind: "test", lines: ["+c"] },
            ],
          },
        ];
        return Promise.resolve(b);
      },
    });
    registry.add(ref(1));
    await registry.settled();
    expect(registry.get("a/b#1")!.size).toEqual({
      byKind: {
        core: { additions: 1, deletions: 1 },
        test: { additions: 1, deletions: 0 },
        boilerplate: { additions: 0, deletions: 0 },
      },
      total: { additions: 2, deletions: 1 },
    });
    registry.dispose();
  });

  it("drops a removed PR, even one still queued", async () => {
    const { build, pending } = manualBuild();
    const registry = new PrRegistry({ build, concurrency: 1 });
    registry.add(ref(1));
    registry.add(ref(2));
    await tick();
    expect(registry.remove("a/b#2")).toBe(true);
    expect(registry.remove("a/b#2")).toBe(false);
    pending.get(urlOf(1))!.resolve();
    await registry.settled();
    expect(registry.list().map((p) => p.key)).toEqual(["a/b#1"]);
    registry.dispose();
  });

  it("starts language services on the first question and lets them go on goodbye", async () => {
    const { build, pending } = manualBuild();
    const registry = new PrRegistry({ build, sessionGraceMs: 30 });
    registry.add(ref(1));
    await tick();
    pending.get(urlOf(1))!.resolve();
    await registry.settled();

    // Not built ≠ built-but-cold: an unknown key has no session to start.
    expect(registry.sessionFor("a/b#9")).toBeNull();
    expect(registry.get("a/b#1")?.live).toBe(false);
    const session = registry.sessionFor("a/b#1");
    expect(session).not.toBeNull();
    expect(registry.get("a/b#1")?.live).toBe(true);
    // The same session answers the next question.
    expect(registry.sessionFor("a/b#1")).toBe(session);

    // Goodbye then hello inside the grace: the session stays.
    registry.pageGone("a/b#1");
    registry.pageAlive("a/b#1");
    await new Promise((r) => setTimeout(r, 60));
    expect(registry.get("a/b#1")?.live).toBe(true);

    // Goodbye alone: the session goes; the entry stays ready.
    registry.pageGone("a/b#1");
    await new Promise((r) => setTimeout(r, 60));
    expect(registry.get("a/b#1")).toMatchObject({ live: false, state: "ready" });
    registry.dispose();
  });
});

describe("PrRegistry persistence", () => {
  let home: string;
  let stateFile: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "registry-state-"));
    stateFile = path.join(home, "state", "registry.json");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /** A build that counts how often it was asked, and finishes at once. */
  function countingBuild() {
    let calls = 0;
    const build = ({ prUrl, navBase }: { prUrl: string; navBase: string }) => {
      calls++;
      return Promise.resolve(built(Number(prUrl.split("/").pop()), navBase));
    };
    return { build, calls: () => calls };
  }

  it("brings a ready PR back in a fresh registry without building it again", async () => {
    const first = countingBuild();
    const registry = new PrRegistry({ build: first.build, stateFile });
    registry.add(ref(1), { maxGraphs: 3 });
    await registry.settled();
    const before = registry.get("a/b#1")!;
    registry.dispose();
    expect(first.calls()).toBe(1);

    const second = countingBuild();
    const reloaded = new PrRegistry({ build: second.build, stateFile });
    const after = reloaded.get("a/b#1");
    expect(second.calls()).toBe(0);
    expect(after).toMatchObject({
      key: "a/b#1",
      state: "ready",
      title: "PR 1",
      slices: 0,
      graphs: 0,
      path: "/pr/a/b/1/",
      addedAt: before.addedAt,
      readyAt: before.readyAt,
      live: false,
    });
    expect(reloaded.html("a/b#1")).toBe("<html>1</html>");
    // The PR is fully here: adding it again is the usual no-op, not a build.
    reloaded.add(ref(1));
    await reloaded.settled();
    expect(second.calls()).toBe(0);
    // What was written names the PR and what it was added with.
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({
      version: 1,
      prs: [{ owner: "a", repo: "b", number: 1, options: { maxGraphs: 3 } }],
    });
    reloaded.dispose();
  });

  it("forgets a removed PR on disk too, so a restart does not bring it back", async () => {
    const { build } = countingBuild();
    const registry = new PrRegistry({ build, stateFile });
    registry.add(ref(1));
    registry.add(ref(2));
    await registry.settled();
    expect(JSON.parse(readFileSync(stateFile, "utf8")).prs).toHaveLength(2);
    // The watcher does this when a PR is merged or closed. If the file still
    // held it, the next restart would put a finished PR back on the index.
    expect(registry.remove("a/b#1")).toBe(true);
    registry.dispose();

    const reloaded = new PrRegistry({ build, stateFile });
    expect(reloaded.list().map((p) => p.key)).toEqual(["a/b#2"]);
    reloaded.dispose();
  });

  it.each([
    ["no file", null],
    ["an empty file", ""],
    ["a file that is not JSON", "{ this is not"],
    ["JSON of the wrong shape", JSON.stringify({ prs: "many", version: 1 })],
  ])("starts empty given %s", (_name, contents) => {
    if (contents !== null) {
      mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, contents);
    }
    const { build, calls } = countingBuild();
    const registry = new PrRegistry({ build, stateFile });
    expect(registry.list()).toEqual([]);
    expect(calls()).toBe(0);
    registry.dispose();
  });

  it("skips a record it cannot trust rather than crashing on it later", async () => {
    const { build } = countingBuild();
    const registry = new PrRegistry({ build, stateFile });
    registry.add(ref(1));
    await registry.settled();
    registry.dispose();
    const saved = JSON.parse(readFileSync(stateFile, "utf8")) as { prs: unknown[] };
    saved.prs.push({ owner: "a", repo: "b", number: 2 }, null, "a/b#3");
    writeFileSync(stateFile, JSON.stringify(saved));

    const reloaded = new PrRegistry({ build, stateFile });
    expect(reloaded.list().map((p) => p.key)).toEqual(["a/b#1"]);
    reloaded.dispose();
  });

  it("does not remember what was still queued, building or failed", async () => {
    const { build, pending } = manualBuild();
    const registry = new PrRegistry({ build, concurrency: 1, stateFile });
    registry.add(ref(1));
    registry.add(ref(2));
    registry.add(ref(3));
    await tick();
    // 1 builds and fails; 2 builds and is ready; 3 is still building and 4
    // queued at the moment the last write happens.
    pending.get(urlOf(1))!.reject(new Error("no key"));
    await tick();
    pending.get(urlOf(2))!.resolve();
    await tick();
    registry.add(ref(4));
    await tick();
    expect(registry.list().map((p) => p.state)).toEqual(["failed", "ready", "building", "queued"]);
    registry.dispose();

    const next = countingBuild();
    const reloaded = new PrRegistry({ build: next.build, stateFile });
    // Only the ready one is back; nothing came back as ready without having been built.
    expect(reloaded.list().map((p) => [p.key, p.state])).toEqual([["a/b#2", "ready"]]);
    expect(next.calls()).toBe(0);
    // The others are simply gone, so adding them again builds them.
    reloaded.add(ref(1));
    reloaded.add(ref(3));
    await reloaded.settled();
    expect(next.calls()).toBe(2);
    reloaded.dispose();
  });

  it("serves a restored page whose checkout has vanished, and fails only the question asked of it", async () => {
    const gone = path.join(home, "head");
    mkdirSync(gone);
    const build = ({ prUrl, navBase }: { prUrl: string; navBase: string }) =>
      Promise.resolve({ ...built(Number(prUrl.split("/").pop()), navBase), headDir: gone });
    const registry = new PrRegistry({ build, stateFile });
    registry.add(ref(1));
    registry.add(ref(2));
    await registry.settled();
    registry.dispose();
    rmSync(gone, { recursive: true });

    const reloaded = new PrRegistry({ build, stateFile });
    expect(reloaded.get("a/b#1")).toMatchObject({ state: "ready", title: "PR 1" });
    expect(reloaded.html("a/b#1")).toBe("<html>1</html>");
    expect(() => reloaded.sessionFor("a/b#1")).toThrow(/head checkout for a\/b#1 is gone/);
    // Nothing else changed: the entry is still here and ready, not live, and
    // the other PR is untouched.
    expect(reloaded.get("a/b#1")).toMatchObject({ state: "ready", live: false });
    expect(reloaded.list().map((p) => p.key)).toEqual(["a/b#1", "a/b#2"]);
    expect(() => reloaded.sessionFor("a/b#2")).toThrow(/gone/);
    reloaded.dispose();
  });
});
