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
import process from "node:process";
import type { AddressInfo } from "node:net";
import { renderSliceExplorerHtml, type SliceExplorerInput } from "@deep-review/call-graph";
import { renderBuildingPage, renderIndexPage } from "./indexPage.js";
import {
  parsePrPath,
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body is not JSON");
  }
}

/**
 * Whether a state-changing request came from somewhere other than this
 * server's own pages or a local program. The server is loopback-only, but
 * any web page a browser visits can still *send* to 127.0.0.1 (CSRF needs
 * no CORS approval to fire), so a POST carrying a foreign Origin — or a
 * Host that is not this server — could stop the server or spend the model
 * budget from a drive-by tab. The CLI and the pages themselves pass: node
 * sends no Origin, and the pages' own beacons are same-origin.
 */
function crossSite(req: IncomingMessage): boolean {
  const port = req.socket.localPort;
  const own = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const host = req.headers.host;
  if (!host || !own.has(host.toLowerCase())) return true;
  const origin = req.headers.origin;
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return true;
    }
    if (!own.has(originHost)) return true;
  }
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return true;
  return false;
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
  /** `/quit` was received; the server is about to go. Pages polling `/status` see it first. */
  let stopping = false;

  const shutdown = async (): Promise<void> => {
    if (stopped) return closed;
    stopped = true;
    stopping = true;
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
      case "/definition":
      case "/references":
      case "/panel": {
        const session = registry.sessionFor(key);
        if (!session) {
          sendJson(res, 409, { why: "not built yet" });
          return;
        }
        if (rest === "/definition") {
          const file = url.searchParams.get("file");
          const line = intParam(url, "line");
          const col = intParam(url, "col");
          if (!file || line === null || col === null) {
            sendJson(res, 400, { why: "file, line and col are required" });
            return;
          }
          sendJson(res, 200, await session.definition(file, line, col));
          return;
        }
        const id = url.searchParams.get("id");
        if (rest === "/references") {
          const refs = id ? await session.references(id) : null;
          if (!refs) sendJson(res, 404, { why: "unknown definition" });
          else sendJson(res, 200, refs);
          return;
        }
        const panel = id ? await session.panel(id) : null;
        if (!panel) sendJson(res, 404, { why: "no panel" });
        else sendJson(res, 200, panel);
        return;
      }
      // The page's status pill asks this: is the server here, is the PR
      // built, are its language services up, is anything being answered.
      // Not a use — it never starts a session or counts as activity.
      case "/status": {
        const status = registry.status(key);
        if (!status) {
          sendJson(res, 404, { why: "no such PR on this server" });
          return;
        }
        sendJson(res, 200, { ok: true, stopping, ...status });
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

    // Everything that changes state is a non-GET; none of it is for a
    // foreign page. (GET responses are unreadable cross-origin anyway —
    // no CORS headers are ever sent.)
    if (method !== "GET" && method !== "HEAD" && crossSite(req)) {
      sendJson(res, 403, { why: "not from this server's own pages" });
      return;
    }

    // Server-wide routes first; a PR can never be named `_`.
    if (method === "POST" && path === "/quit") {
      stopping = true;
      res.writeHead(204, NO_STORE);
      res.end();
      log("asked to stop.");
      setTimeout(() => void shutdown(), 10);
      return;
    }
    if (method === "GET" && path === "/health") {
      sendJson(res, 200, {
        ok: true,
        stopping,
        version: VERSION,
        pid: process.pid,
        prs: registry.count(),
        // The server keeps the env of whichever shell spawned it; telling
        // callers whether it holds a GitHub token lets a CLI whose shell
        // has one warn that the server cannot see it.
        hasGithubToken: Boolean(process.env.GITHUB_TOKEN),
      });
      return;
    }
    if (path === "/prs") {
      if (method === "GET") {
        sendJson(res, 200, { prs: registry.list() });
        return;
      }
      if (method === "POST") {
        let parsed: unknown;
        try {
          parsed = await readJsonBody(req);
        } catch (error) {
          sendJson(res, 400, { why: error instanceof Error ? error.message : "bad body" });
          return;
        }
        const body = parsed as {
          owner?: string;
          repo?: string;
          number?: number;
          options?: AddOptions;
        };
        if (!body.owner || !body.repo || !Number.isInteger(body.number)) {
          sendJson(res, 400, { why: "owner, repo and number are required" });
          return;
        }
        const ref = { owner: body.owner, repo: body.repo, number: body.number! };
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
      let key: string;
      try {
        key = decodeURIComponent(path.slice("/prs/".length));
      } catch {
        // A malformed percent-escape is a bad address, not a server fault.
        sendJson(res, 404, { why: "no such PR on this server" });
        return;
      }
      sendJson(res, 200, { removed: registry.remove(key) });
      return;
    }

    const route = parsePrPath(path);
    if (route) {
      // The page's goodbye: this PR's session may go, the server stays.
      if (method === "POST" && route.rest === "/gone") {
        registry.pageGone(route.key);
        res.writeHead(204, NO_STORE);
        res.end();
        return;
      }
      // A mutating route under a PR prefix must be named above this line,
      // as /gone is — anything else non-GET answers 405 here before any
      // handler below could see it.
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
        if (route.rest === "/") {
          sendHtml(res, 404, notHere(route.key));
          return;
        }
        sendJson(res, 404, { why: "no such PR on this server" });
        return;
      }
      if (route.rest === "/") {
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
  const ref: PrRef = { owner, repo, number: options.input.number };
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
