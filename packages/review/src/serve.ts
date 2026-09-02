/**
 * The local navigation server behind rendered explorer pages: serves an
 * index of every PR it holds, each PR's page under its own prefix, and
 * answers those pages' questions about symbols — where one is defined, who
 * calls it, what its panel looks like — from language services kept warm
 * over that PR's head checkout.
 *
 * Loopback only, and long-lived: one server holds however many PRs you are
 * reading, PRs are added to a running one from any terminal, and a page
 * going away lets go of that PR's language services without touching
 * anybody else's. It stops when asked to (`/quit`, Ctrl-C), not on its own.
 */

import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { renderSliceExplorerHtml, type SliceExplorerInput } from "@deep-review/call-graph";
import { renderBuildingPage, renderIndexPage } from "./indexPage.js";
import {
  PrRegistry,
  prKey,
  prMountPath,
  type AddOptions,
  type BuildPr,
  type PrRef,
  type PrView,
} from "./registry.js";

export const VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export interface NavServerOptions {
  /** Turns a PR into a built page; see `BuildPr`. */
  build: BuildPr;
  /**
   * Where a PR's head is right now, asked when an already-built PR is added
   * again: a head that moved means the build is stale and is rebuilt rather
   * than returned. Absent (or answering null — rate limit, no token), the
   * existing build is trusted.
   */
  currentHeadSha?: ((ref: PrRef) => Promise<string | null>) | undefined;
  /** Port to listen on; 0 (the default) picks a free one. */
  port?: number | undefined;
  /** How many PRs may build at once. */
  concurrency?: number | undefined;
  /**
   * How long after a page says it is gone that PR's language services are
   * let go. A reload says goodbye before the new page says hello, so this
   * is the window the new page has to cancel the goodbye.
   */
  sessionGraceMs?: number | undefined;
  /** Let a PR's language services go after this long with no question asked. */
  sessionIdleMs?: number | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

export interface NavServer {
  /** The index: every PR this server holds. */
  url: string;
  port: number;
  /** Add a PR (or return the one already here); it builds in the background. */
  add(ref: PrRef, options?: AddOptions): PrView;
  /** The page URL for a PR, ready or not. */
  urlFor(ref: Pick<PrRef, "owner" | "repo" | "number">): string;
  registry: PrRegistry;
  /** Resolves once the server has stopped, by `/quit` or by `close()`. */
  closed: Promise<void>;
  close(): Promise<void>;
}

const NO_STORE = { "Cache-Control": "no-store" };

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...NO_STORE, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { ...NO_STORE, "Content-Type": type });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  sendText(res, status, "text/html; charset=utf-8", html);
}

function intParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

async function readJsonBody(req: IncomingMessage, limit = 1 << 20): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * A request under a PR's prefix, split into the PR it names and the rest of
 * the path. `/pr/vercel/swr/2950/panel` → that PR, `/panel`.
 */
interface PrRoute {
  key: string;
  rest: string;
  /** The request pointed at the PR itself without a trailing slash. */
  needsSlash: boolean;
  mount: string;
}

function routePr(pathname: string): PrRoute | null {
  const parts = pathname.split("/").filter((p) => p !== "");
  if (parts.length < 4 || parts[0] !== "pr") return null;
  const owner = decodeURIComponent(parts[1]!);
  const repo = decodeURIComponent(parts[2]!);
  const number = Number(parts[3]);
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) return null;
  const ref = { owner, repo, number };
  return {
    key: prKey(ref),
    rest: `/${parts.slice(4).join("/")}`,
    needsSlash: parts.length === 4 && !pathname.endsWith("/"),
    mount: prMountPath(ref),
  };
}

export async function startNavServer(options: NavServerOptions): Promise<NavServer> {
  const log = options.onProgress ?? (() => {});
  const registry = new PrRegistry({
    build: options.build,
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.sessionGraceMs !== undefined ? { sessionGraceMs: options.sessionGraceMs } : {}),
    ...(options.sessionIdleMs !== undefined ? { sessionIdleMs: options.sessionIdleMs } : {}),
    onProgress: log,
  });

  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let server: Server;
  let stopped = false;

  const shutdown = async (): Promise<void> => {
    if (stopped) return closed;
    stopped = true;
    registry.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    resolveClosed();
    return closed;
  };

  /** The symbol questions, all scoped to one PR's language services. */
  const handleNav = async (
    key: string,
    rest: string,
    url: URL,
    res: ServerResponse,
  ): Promise<void> => {
    switch (rest) {
      case "/definition": {
        const session = registry.sessionFor(key);
        const file = url.searchParams.get("file");
        const line = intParam(url, "line");
        const col = intParam(url, "col");
        if (!file || line === null || col === null) {
          sendJson(res, 400, { why: "file, line and col are required" });
          return;
        }
        if (!session) {
          sendJson(res, 409, { why: "not built yet" });
          return;
        }
        sendJson(res, 200, await session.definition(file, line, col));
        return;
      }
      case "/references": {
        const session = registry.sessionFor(key);
        const id = url.searchParams.get("id");
        const refs = session && id ? await session.references(id) : null;
        if (!refs) sendJson(res, 404, { why: "unknown definition" });
        else sendJson(res, 200, refs);
        return;
      }
      case "/panel": {
        const session = registry.sessionFor(key);
        const id = url.searchParams.get("id");
        const panel = session && id ? await session.panel(id) : null;
        if (!panel) sendJson(res, 404, { why: "no panel" });
        else sendJson(res, 200, panel);
        return;
      }
      // The page says hello as it loads — after a reload, that is what
      // cancels the goodbye the previous page sent — and browsers ask for a
      // favicon unprompted; an empty answer keeps the console clean.
      case "/alive": {
        registry.pageAlive(key);
        res.writeHead(204, NO_STORE);
        res.end();
        return;
      }
      case "/favicon.ico": {
        res.writeHead(204, NO_STORE);
        res.end();
        return;
      }
      default:
        sendText(res, 404, "text/plain", "not found");
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";

    // Server-wide routes first; a PR can never be named `_`.
    if (method === "POST" && path === "/quit") {
      res.writeHead(204, NO_STORE);
      res.end();
      log("asked to stop.");
      setTimeout(() => void shutdown(), 10);
      return;
    }
    if (method === "GET" && path === "/health") {
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        pid: process.pid,
        prs: registry.list().length,
      });
      return;
    }
    if (path === "/prs") {
      if (method === "GET") {
        sendJson(res, 200, { prs: registry.list() });
        return;
      }
      if (method === "POST") {
        const body = (await readJsonBody(req)) as {
          owner?: string;
          repo?: string;
          number?: number;
          prUrl?: string;
          options?: AddOptions;
        };
        if (!body.owner || !body.repo || !Number.isInteger(body.number) || !body.prUrl) {
          sendJson(res, 400, { why: "owner, repo, number and prUrl are required" });
          return;
        }
        const ref = { owner: body.owner, repo: body.repo, number: body.number!, prUrl: body.prUrl };
        // Re-adding a PR normally returns the build already here — unless
        // its head has moved since, in which case the reader is asking for
        // a review of code the build no longer shows: drop it and rebuild.
        const existing = registry.get(prKey(ref));
        if (existing?.state === "ready" && existing.headSha && options.currentHeadSha) {
          const live = await options.currentHeadSha(ref).catch(() => null);
          if (live && live !== existing.headSha) {
            log(`${existing.key}: head moved ${existing.headSha.slice(0, 8)} → ${live.slice(0, 8)}; rebuilding.`);
            registry.remove(existing.key);
          }
        }
        const pr = registry.add(ref, body.options ?? {});
        sendJson(res, 200, { pr });
        return;
      }
      sendText(res, 405, "text/plain", "method not allowed");
      return;
    }
    if (path.startsWith("/prs/") && method === "DELETE") {
      const key = decodeURIComponent(path.slice("/prs/".length));
      sendJson(res, 200, { removed: registry.remove(key) });
      return;
    }

    const route = routePr(path);
    if (route) {
      // The page's goodbye: this PR's session may go, the server stays.
      if (method === "POST" && route.rest === "/gone") {
        registry.pageGone(route.key);
        res.writeHead(204, NO_STORE);
        res.end();
        return;
      }
      if (method !== "GET" && method !== "HEAD") {
        sendText(res, 405, "text/plain", "method not allowed");
        return;
      }
      // Relative asking only works from a directory URL.
      if (route.needsSlash) {
        res.writeHead(302, { ...NO_STORE, Location: route.mount + url.search });
        res.end();
        return;
      }
      const pr = registry.get(route.key);
      if (!pr) {
        if (route.rest === "/" || route.rest === "") {
          sendHtml(res, 404, notHere(route.key));
          return;
        }
        sendJson(res, 404, { why: "no such PR on this server" });
        return;
      }
      if (route.rest === "/" || route.rest === "") {
        const html = registry.html(route.key);
        if (html) {
          registry.pageAlive(route.key);
          sendHtml(res, 200, html);
        } else {
          // Not built yet (or the build failed): a page that watches for it.
          sendHtml(res, 200, renderBuildingPage(pr));
        }
        return;
      }
      await handleNav(route.key, route.rest, url, res);
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      sendText(res, 405, "text/plain", "method not allowed");
      return;
    }
    if (path === "/") {
      sendHtml(res, 200, renderIndexPage(registry.list(), VERSION));
      return;
    }
    if (path === "/favicon.ico") {
      res.writeHead(204, NO_STORE);
      res.end();
      return;
    }
    sendText(res, 404, "text/plain", "not found");
  };

  server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`navigation: ${message}`);
      if (!res.headersSent) sendJson(res, 500, { why: message });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    url: `${origin}/`,
    port,
    add: (ref, addOptions) => registry.add(ref, addOptions ?? {}),
    urlFor: (ref) => `${origin}${prMountPath(ref)}`,
    registry,
    closed,
    close: shutdown,
  };
}

function notHere(key: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${key} — not loaded</title></head>
<body><p><code>${key}</code> is not loaded on this server.</p>
<p><a href="/">Every PR that is</a></p></body></html>
`;
}

export interface ServeOptions {
  /** The PR's head checkout the language services read. */
  headDir: string;
  /** What to render and serve; the session renders more panels from it. */
  input: SliceExplorerInput;
  port?: number | undefined;
  sessionGraceMs?: number | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

/**
 * A server holding a single already-built PR — what `--no-daemon` runs, and
 * the shape the tests exercise. The page is rendered here rather than taken
 * from the caller so its `navBase` matches where the server mounts it; a
 * static `--out` copy is rendered separately, without one.
 */
export async function serveExplorer(
  options: ServeOptions,
): Promise<NavServer & { pageUrl: string }> {
  const [owner = "unknown", repo = "unknown"] = options.input.repo.split("/");
  const ref: PrRef = {
    owner,
    repo,
    number: options.input.number,
    prUrl: options.input.prUrl,
  };
  const server = await startNavServer({
    build: ({ navBase }) => {
      const input = { ...options.input, navBase };
      return Promise.resolve({
        input,
        headDir: options.headDir,
        html: renderSliceExplorerHtml(input),
      });
    },
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.sessionGraceMs !== undefined ? { sessionGraceMs: options.sessionGraceMs } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  server.add(ref);
  await server.registry.settled();
  return { ...server, pageUrl: server.urlFor(ref) };
}
