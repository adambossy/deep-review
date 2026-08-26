/**
 * The local navigation server behind a rendered explorer page: serves the
 * page, and answers the page's questions about symbols — where one is
 * defined, who calls it, what its panel looks like — from language services
 * kept warm over the PR's head checkout. Loopback only, one PR, gone when
 * the page is.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { NavSession, type SliceExplorerInput } from "@deep-review/call-graph";

export interface ServeOptions {
  /** The PR's head checkout the language services read. */
  headDir: string;
  /** What the page was rendered from; the session renders more panels from it. */
  input: SliceExplorerInput;
  /** The rendered explorer page. */
  html: string;
  /** Port to listen on; 0 (the default) picks a free one. */
  port?: number | undefined;
  /**
   * How long a shutdown request waits before taking effect. The page asks
   * for one when it unloads — on a reload as much as on a close — so the
   * server gives the page this long to come back before believing it.
   */
  shutdownGraceMs?: number | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

export interface NavServer {
  url: string;
  port: number;
  /** Resolves once the server has stopped: asked to by the page, or by `close()`. */
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

function intParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export async function serveExplorer(options: ServeOptions): Promise<NavServer> {
  const log = options.onProgress ?? (() => {});
  const grace = options.shutdownGraceMs ?? 3000;
  const session = new NavSession(options.headDir, options.input, {
    debug: options.input.debugMarks,
  });

  let stopping: NodeJS.Timeout | null = null;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let server: Server;

  const shutdown = async (): Promise<void> => {
    if (stopping) clearTimeout(stopping);
    stopping = null;
    session.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    resolveClosed();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Any request means the page is still here: forget a pending shutdown.
    if (stopping) {
      clearTimeout(stopping);
      stopping = null;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/shutdown") {
      res.writeHead(204, NO_STORE);
      res.end();
      stopping = setTimeout(() => {
        log("page closed; stopping.");
        void shutdown();
      }, grace);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendText(res, 405, "text/plain", "method not allowed");
      return;
    }
    switch (url.pathname) {
      case "/": {
        sendText(res, 200, "text/html; charset=utf-8", options.html);
        return;
      }
      case "/definition": {
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
      case "/references": {
        const id = url.searchParams.get("id");
        const refs = id ? await session.references(id) : null;
        if (!refs) sendJson(res, 404, { why: "unknown definition" });
        else sendJson(res, 200, refs);
        return;
      }
      case "/panel": {
        const id = url.searchParams.get("id");
        const panel = id ? await session.panel(id) : null;
        if (!panel) sendJson(res, 404, { why: "no panel" });
        else sendJson(res, 200, panel);
        return;
      }
      // The page says hello as it loads — after a reload, that is what
      // cancels the goodbye the previous page sent — and browsers ask for a
      // favicon unprompted; an empty answer keeps the console clean.
      case "/alive":
      case "/favicon.ico": {
        res.writeHead(204, NO_STORE);
        res.end();
        return;
      }
      default:
        sendText(res, 404, "text/plain", "not found");
    }
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
  session.warm();

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    closed,
    close: shutdown,
  };
}
