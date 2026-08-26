import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderSliceExplorerHtml, type SliceExplorerInput } from "@deep-review/call-graph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveExplorer, type NavServer } from "./serve.js";

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
const html = renderSliceExplorerHtml(input);

let server: NavServer;
beforeAll(async () => {
  server = await serveExplorer({ headDir, input, html, shutdownGraceMs: 60 });
});
afterAll(async () => {
  await server.close();
  rmSync(headDir, { recursive: true, force: true });
});

const get = (route: string) => fetch(new URL(route, server.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (route: string): Promise<any> => (await get(route)).json();

describe("serveExplorer", () => {
  it("listens on loopback on a free port and serves the page uncached", async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(html);
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

  it("stops after a shutdown request unless the page comes back first", async () => {
    const post = () => fetch(new URL("/shutdown", server.url), { method: "POST" });
    expect((await post()).status).toBe(204);
    // A reload: the new page says hello inside the grace period.
    expect((await get("/alive")).status).toBe(204);
    await new Promise((r) => setTimeout(r, 120));
    expect((await get("/")).status).toBe(200);

    // Nobody comes back: the server goes.
    await post();
    await Promise.race([server.closed, new Promise((_, reject) => setTimeout(() => reject(new Error("still up")), 2000))]);
    await expect(get("/")).rejects.toThrow();
  }, 10_000);
});
