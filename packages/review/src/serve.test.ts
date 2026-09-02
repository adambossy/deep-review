import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SliceExplorerInput } from "@deep-review/call-graph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveExplorer, startNavServer, type NavServer } from "./serve.js";

// A two-file TS project as the head checkout; the slice changes use.ts.
const headDir = mkdtempSync(path.join(os.tmpdir(), "serve-test-"));
const libText = ["export const LIMIT = 3;", "", "export function helper(n: number): number {", "  return n + LIMIT;", "}"];
const useText = [
  'import { helper, LIMIT } from "./lib.js";',
  "",
  "export function use(x: number): number {",
  "  return helper(x) + LIMIT;",
  "}",
];
writeFileSync(path.join(headDir, "lib.ts"), libText.join("\n"));
writeFileSync(path.join(headDir, "use.ts"), useText.join("\n"));

const input: SliceExplorerInput = {
  prUrl: "https://github.com/a/b/pull/1",
  prTitle: "A PR",
  repo: "a/b",
  number: 1,
  overview: "o",
  files: [{ side: "after", path: "use.ts", lines: useText, symbols: [] }],
  slices: [
    {
      id: "s1",
      title: "Use helper",
      summary: "s",
      rationale: "r",
      fragments: [
        {
          id: "use.ts#0@4-4",
          file: "use.ts",
          summary: "f",
          hunkHeader: "@@ -4,1 +4,1 @@",
          lines: ["+  return helper(x) + LIMIT;"],
          newLineNumbers: [4],
          headStart: 4,
          headEnd: 4,
        },
      ],
    },
  ],
};

let server: NavServer & { pageUrl: string };
beforeAll(async () => {
  server = await serveExplorer({ headDir, input, sessionGraceMs: 60 });
});
afterAll(async () => {
  await server.close();
  rmSync(headDir, { recursive: true, force: true });
});

// PR routes are relative to the page's own prefix, as the page asks them.
const get = (route: string) => fetch(new URL(route.replace(/^\//, ""), server.pageUrl));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (route: string): Promise<any> => (await get(route)).json();

describe("serveExplorer", () => {
  it("mounts the PR under its own prefix and serves the page uncached", async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(server.pageUrl).toBe(`${server.url}pr/a/b/1/`);
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The page knows its own mount, so its questions come back here.
    expect(await res.text()).toContain('window.NAV_BASE = "/pr/a/b/1/"');
  });

  it("redirects the PR's URL without its trailing slash", async () => {
    const res = await fetch(server.pageUrl.replace(/\/$/, ""), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/pr/a/b/1/");
  });

  it("serves an index of what it holds at the root", async () => {
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("a/b#1");
    expect(body).toContain('href="/pr/a/b/1/"');
  });

  it("says what it is over /health and /prs", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const health: any = await (await fetch(new URL("/health", server.url))).json();
    expect(health.ok).toBe(true);
    expect(health.prs).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { prs }: any = await (await fetch(new URL("/prs", server.url))).json();
    expect(prs.map((p: { key: string; state: string }) => [p.key, p.state])).toEqual([["a/b#1", "ready"]]);
  });

  it("answers /definition with a stable id and the panel to open", async () => {
    const first = await json("/definition?file=use.ts&line=4&col=9");
    const second = await json("/definition?file=use.ts&line=4&col=9");
    expect(first).toEqual(second);
    expect([first.name, first.kind, first.self, first.panelId]).toEqual(["helper", "function", false, `def:${first.id}`]);
    expect(first.decl).toEqual({ file: "lib.ts", line: 3, column: 16, endColumn: 22 });
  }, 30_000);

  it("rejects a malformed /definition and explains a miss", async () => {
    expect((await get("/definition?file=use.ts&line=x")).status).toBe(400);
    const miss = await get("/definition?file=use.ts&line=2&col=0");
    expect(miss.status).toBe(200);
    expect(await miss.json()).toEqual({ why: "no definition" });
  }, 30_000);

  it("answers /references and /panel for an id it handed out, 404 otherwise", async () => {
    const helper = await json("/definition?file=use.ts&line=4&col=9");
    const refs = await json(`/references?id=${helper.id}`);
    expect(refs.kind).toBe("calls");
    expect(refs.sites.map((s: { enclosingName: string; line: number }) => [s.enclosingName, s.line])).toEqual([["use", 4]]);

    const panel = await get(`/panel?id=${encodeURIComponent(helper.panelId)}`);
    expect(panel.status).toBe(200);
    const body = await json(`/panel?id=${encodeURIComponent(helper.panelId)}`);
    expect(body.name).toBe("helper");
    expect(body.html).toContain(`data-node="${helper.panelId}"`);

    expect((await get("/references?id=d999")).status).toBe(404);
    expect((await get("/panel?id=def:d999")).status).toBe(404);
    expect((await get("/nope")).status).toBe(404);
  }, 30_000);

  it("404s a PR it does not hold", async () => {
    expect((await fetch(new URL("/pr/a/b/2/", server.url))).status).toBe(404);
    expect((await fetch(new URL("/pr/a/b/2/panel?id=x", server.url))).status).toBe(404);
  });

  it("lets a page's language services go when it leaves, without stopping", async () => {
    // Warm the session, then say goodbye.
    await json("/definition?file=use.ts&line=4&col=9");
    expect(server.registry.get("a/b#1")?.live).toBe(true);
    const gone = () => fetch(new URL("gone", server.pageUrl), { method: "POST" });
    expect((await gone()).status).toBe(204);
    // A reload: the new page says hello inside the grace period.
    expect((await get("/alive")).status).toBe(204);
    await new Promise((r) => setTimeout(r, 120));
    expect(server.registry.get("a/b#1")?.live).toBe(true);

    // Nobody comes back: the session goes, the server stays.
    await gone();
    await new Promise((r) => setTimeout(r, 120));
    expect(server.registry.get("a/b#1")?.live).toBe(false);
    expect((await get("/")).status).toBe(200);

    // The next question simply starts them again.
    const again = await json("/definition?file=use.ts&line=4&col=9");
    expect(again.name).toBe("helper");
    expect(server.registry.get("a/b#1")?.live).toBe(true);
  }, 30_000);

  it("rebuilds a held PR whose head has moved, and only then", async () => {
    let liveHead = "aaa1111";
    let builds = 0;
    const fresh = await startNavServer({
      build: ({ navBase }) => {
        builds++;
        const rebuilt = { ...input, navBase };
        return Promise.resolve({ input: rebuilt, headDir, html: "<html></html>", headSha: liveHead });
      },
      currentHeadSha: () => Promise.resolve(liveHead),
    });
    const addBody = JSON.stringify({ owner: "a", repo: "b", number: 1, prUrl: input.prUrl });
    const add = () =>
      fetch(new URL("/prs", fresh.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: addBody,
      });
    await add();
    await fresh.registry.settled();
    expect(builds).toBe(1);
    expect(fresh.registry.get("a/b#1")?.headSha).toBe("aaa1111");

    // Head unchanged: the same build is returned, nothing re-runs.
    await add();
    await fresh.registry.settled();
    expect(builds).toBe(1);

    // Head moved: the stale build is dropped and remade at the new head.
    liveHead = "bbb2222";
    await add();
    await fresh.registry.settled();
    expect(builds).toBe(2);
    expect(fresh.registry.get("a/b#1")?.headSha).toBe("bbb2222");
    await fresh.close();
  }, 15_000);

  it("stops when asked over /quit", async () => {
    expect((await fetch(new URL("/quit", server.url), { method: "POST" })).status).toBe(204);
    await Promise.race([server.closed, new Promise((_, reject) => setTimeout(() => reject(new Error("still up")), 2000))]);
    await expect(fetch(server.url)).rejects.toThrow();
  }, 10_000);
});
