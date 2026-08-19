import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Minimal JSON-RPC/LSP client over stdio: enough to initialize a server,
 * make requests, and answer the handful of server→client requests language
 * servers send (configuration, capability registration).
 */
export class LspClient {
  private child: ChildProcess;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    command: string,
    args: string[],
    readonly rootDir: string,
  ) {
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    this.child.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.on("exit", () => {
      const error = new Error("language server exited");
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    });
  }

  async initialize(): Promise<void> {
    const rootUri = pathToFileURL(this.rootDir).href;
    await this.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          callHierarchy: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
        workspace: { symbol: {} },
      },
      workspaceFolders: [{ uri: rootUri, name: "root" }],
    });
    this.notify("initialized", {});
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async dispose(): Promise<void> {
    try {
      await this.request("shutdown", null, 3000);
      this.notify("exit", null);
    } catch {
      // The server may already be gone; killing below is the backstop.
    }
    this.child.kill();
  }

  private send(message: RpcMessage): void {
    const json = JSON.stringify(message);
    this.child.stdin!.write(
      `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`,
    );
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const lengthMatch = /Content-Length: (\d+)/i.exec(header);
      if (!lengthMatch) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        this.handle(JSON.parse(body) as RpcMessage);
      } catch {
        // Skip unparseable frames rather than wedging the stream.
      }
    }
  }

  private handle(message: RpcMessage): void {
    if (message.method !== undefined && message.id !== undefined) {
      // Server→client request: answer generically so the server proceeds.
      const result =
        message.method === "workspace/configuration"
          ? ((message.params as { items?: unknown[] })?.items ?? []).map(() => null)
          : null;
      this.send({ jsonrpc: "2.0", id: message.id, result });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id as number);
      if (!pending) return;
      this.pending.delete(message.id as number);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
    // Notifications (diagnostics, progress, logs) are ignored.
  }
}
