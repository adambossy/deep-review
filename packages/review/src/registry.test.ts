import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SliceExplorerInput } from "@deep-review/call-graph";
import { afterAll, describe, expect, it } from "vitest";
import { PrRegistry, prKey, prMountPath, type BuiltPr, type PrRef } from "./registry.js";

const headDir = mkdtempSync(path.join(os.tmpdir(), "registry-test-"));
afterAll(() => rmSync(headDir, { recursive: true, force: true }));

function ref(number: number): PrRef {
  return { owner: "a", repo: "b", number, prUrl: `https://github.com/a/b/pull/${number}` };
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
  it("names a PR's key and mount stably", () => {
    expect(prKey(ref(7))).toBe("a/b#7");
    expect(prMountPath(ref(7))).toBe("/pr/a/b/7/");
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
    pending.get(ref(1).prUrl)!.resolve();
    await tick();
    expect(registry.get("a/b#1")?.state).toBe("ready");
    expect(registry.get("a/b#3")?.state).toBe("building");
    expect(registry.html("a/b#1")).toBe("<html>1</html>");
    // The build was told where its page will live.
    expect(registry.get("a/b#1")?.path).toBe("/pr/a/b/1/");
    pending.get(ref(2).prUrl)!.resolve();
    pending.get(ref(3).prUrl)!.resolve();
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
    pending.get(ref(1).prUrl)!.reject(new Error("no key"));
    await registry.settled();
    expect(registry.get("a/b#1")).toMatchObject({ state: "failed", error: "no key" });

    pending.delete(ref(1).prUrl);
    registry.add(ref(1));
    await tick();
    expect(registry.get("a/b#1")?.state).toBe("building");
    pending.get(ref(1).prUrl)!.resolve();
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

  it("drops a removed PR, even one still queued", async () => {
    const { build, pending } = manualBuild();
    const registry = new PrRegistry({ build, concurrency: 1 });
    registry.add(ref(1));
    registry.add(ref(2));
    await tick();
    expect(registry.remove("a/b#2")).toBe(true);
    expect(registry.remove("a/b#2")).toBe(false);
    pending.get(ref(1).prUrl)!.resolve();
    await registry.settled();
    expect(registry.list().map((p) => p.key)).toEqual(["a/b#1"]);
    registry.dispose();
  });

  it("starts language services on the first question and lets them go on goodbye", async () => {
    const { build, pending } = manualBuild();
    const registry = new PrRegistry({ build, sessionGraceMs: 30 });
    registry.add(ref(1));
    await tick();
    pending.get(ref(1).prUrl)!.resolve();
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
