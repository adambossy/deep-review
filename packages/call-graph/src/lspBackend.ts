import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  callSitesFromRanges,
  extractSource,
  type DeclRef,
  type FunctionRelations,
  type LanguageBackend,
  type RelationEntry,
} from "./backend.js";
import { LspClient } from "./lsp.js";
import type { FunctionSnapshot, SymbolRange } from "./types.js";

// --- Minimal LSP wire types (0-based positions) ---
interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
interface LspSymbolInformation {
  name: string;
  kind: number;
  location: { uri: string; range: LspRange };
}
interface LspCallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
}
interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  children?: LspDocumentSymbol[];
}

const SYMBOL_KIND_NAMES: Record<number, string> = {
  5: "class",
  6: "method",
  9: "constructor",
  11: "interface",
  12: "function",
};

const CALLABLE_KINDS = new Set([6, 9, 12]);

export interface LspBackendConfig {
  command: string;
  args: string[];
  languageId: string;
  /** File extensions this backend owns, e.g. [".py"]. */
  extensions: string[];
  /**
   * Matches a line that declares the named function/class. Used to locate
   * declarations by scanning files — language servers like pyright only
   * answer workspace/symbol for files they have already loaded.
   */
  declPattern: (name: string) => RegExp;
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve the pyright language server shipped with the `pyright` package. */
export function pyrightConfig(): LspBackendConfig {
  const require = createRequire(import.meta.url);
  const server = require.resolve("pyright/langserver.index.js");
  return {
    command: process.execPath,
    args: [server, "--stdio"],
    languageId: "python",
    extensions: [".py"],
    declPattern: (name) =>
      new RegExp(`^\\s*(?:async\\s+)?def\\s+${escapeRegExp(name)}\\s*\\(|^\\s*class\\s+${escapeRegExp(name)}\\b`),
  };
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "site-packages",
  "typeshed",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
]);

/** Any LSP server with call-hierarchy support as a LanguageBackend. */
export class LspBackend implements LanguageBackend {
  private client: LspClient | null = null;
  private ready: Promise<LspClient> | null = null;
  private opened = new Set<string>();
  private fileCache = new Map<string, string[]>();
  private symbolCache = new Map<string, LspDocumentSymbol[]>();

  constructor(
    readonly rootDir: string,
    private config: LspBackendConfig,
  ) {}

  private start(): Promise<LspClient> {
    this.ready ??= (async () => {
      this.client = new LspClient(this.config.command, this.config.args, this.rootDir);
      await this.client.initialize();
      return this.client;
    })();
    return this.ready;
  }

  private linesOf(fileName: string): string[] {
    let lines = this.fileCache.get(fileName);
    if (!lines) {
      try {
        lines = readFileSync(fileName, "utf8").split("\n");
      } catch {
        lines = [];
      }
      this.fileCache.set(fileName, lines);
    }
    return lines;
  }

  private async open(client: LspClient, fileName: string): Promise<void> {
    if (this.opened.has(fileName)) return;
    this.opened.add(fileName);
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(fileName).href,
        languageId: this.config.languageId,
        version: 1,
        text: this.linesOf(fileName).join("\n"),
      },
    });
  }

  private isProjectFile(fileName: string): boolean {
    const relative = path.relative(this.rootDir, fileName);
    return (
      !relative.startsWith("..") &&
      !/(^|\/)(node_modules|site-packages|typeshed|\.venv|venv)\//.test(relative)
    );
  }

  private toRelative(fileName: string): string {
    return path.relative(this.rootDir, fileName).split(path.sep).join("/");
  }

  private async docSymbols(fileName: string): Promise<LspDocumentSymbol[]> {
    const cached = this.symbolCache.get(fileName);
    if (cached) return cached;
    const client = await this.start();
    await this.open(client, fileName);
    const symbols =
      (await client.request<LspDocumentSymbol[] | null>("textDocument/documentSymbol", {
        textDocument: { uri: pathToFileURL(fileName).href },
      })) ?? [];
    this.symbolCache.set(fileName, symbols);
    return symbols;
  }

  /**
   * Some servers (pyright) report a call-hierarchy item's range as just the
   * declaration line; recover the full body from document symbols, whose
   * ranges cover the whole definition.
   */
  private async fullRangeOf(item: LspCallHierarchyItem): Promise<LspRange> {
    const contains = (range: LspRange, pos: LspPosition): boolean =>
      (range.start.line < pos.line ||
        (range.start.line === pos.line && range.start.character <= pos.character)) &&
      (range.end.line > pos.line ||
        (range.end.line === pos.line && range.end.character >= pos.character));

    const pos = item.selectionRange.start;
    const deepest = (symbols: LspDocumentSymbol[]): LspRange | null => {
      for (const symbol of symbols) {
        if (!contains(symbol.range, pos)) continue;
        return (symbol.children && deepest(symbol.children)) ?? symbol.range;
      }
      return null;
    };
    const found = deepest(await this.docSymbols(fileURLToPath(item.uri)));
    return found && found.end.line - found.start.line >= item.range.end.line - item.range.start.line
      ? found
      : item.range;
  }

  private async snapshotOfItem(
    item: LspCallHierarchyItem,
    callSites: FunctionSnapshot["callSites"],
    mode: "full" | "contextIfLarge",
  ): Promise<FunctionSnapshot> {
    const fileName = fileURLToPath(item.uri);
    const lines = this.linesOf(fileName);
    const range = await this.fullRangeOf(item);
    const startLine = range.start.line + 1;
    const endLine = range.end.line + 1;
    return {
      file: this.toRelative(fileName),
      startLine,
      endLine,
      callSites,
      ...extractSource(lines, startLine, endLine, callSites, mode),
    };
  }

  private declOfItem(item: LspCallHierarchyItem): DeclRef {
    return {
      fileName: fileURLToPath(item.uri),
      line: item.selectionRange.start.line + 1,
      column: item.selectionRange.start.character,
    };
  }

  private sitesFromRanges(fileName: string, ranges: LspRange[]): FunctionSnapshot["callSites"] {
    return callSitesFromRanges(
      this.linesOf(fileName),
      ranges.map((r) => ({
        startLine: r.start.line + 1,
        startColumn: r.start.character,
        endLine: r.end.line + 1,
        endColumn: r.end.character,
      })),
    );
  }

  private *sourceFiles(dir: string): Generator<string> {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) yield* this.sourceFiles(path.join(dir, entry.name));
      } else if (this.config.extensions.some((ext) => entry.name.endsWith(ext))) {
        yield path.join(dir, entry.name);
      }
    }
  }

  async findFunction(
    name: string,
    preferred: ReadonlySet<string>,
  ): Promise<DeclRef | null> {
    const pattern = this.config.declPattern(name);
    const matches: DeclRef[] = [];
    for (const fileName of this.sourceFiles(this.rootDir)) {
      const lines = this.linesOf(fileName);
      for (let n = 1; n <= lines.length; n++) {
        const match = pattern.exec(lines[n - 1]!);
        if (!match) continue;
        matches.push({
          fileName,
          line: n,
          column: lines[n - 1]!.indexOf(name, match.index),
        });
      }
    }
    if (!matches.length) return null;
    return (
      matches.find((m) => preferred.has(this.toRelative(m.fileName))) ?? matches[0]!
    );
  }

  private async prepare(decl: DeclRef): Promise<LspCallHierarchyItem | null> {
    const client = await this.start();
    await this.open(client, decl.fileName);
    const items = await client.request<LspCallHierarchyItem[] | null>(
      "textDocument/prepareCallHierarchy",
      {
        textDocument: { uri: pathToFileURL(decl.fileName).href },
        position: { line: decl.line - 1, character: decl.column },
      },
    );
    return items?.[0] ?? null;
  }

  async relationsAt(decl: DeclRef): Promise<FunctionRelations | null> {
    const client = await this.start();
    const item = await this.prepare(decl);
    if (!item) return null;

    const [incoming, outgoing] = await Promise.all([
      client.request<Array<{ from: LspCallHierarchyItem; fromRanges: LspRange[] }> | null>(
        "callHierarchy/incomingCalls",
        { item },
      ),
      client.request<Array<{ to: LspCallHierarchyItem; fromRanges: LspRange[] }> | null>(
        "callHierarchy/outgoingCalls",
        { item },
      ),
    ]);

    const callers: RelationEntry[] = [];
    for (const call of incoming ?? []) {
      const fileName = fileURLToPath(call.from.uri);
      if (!this.isProjectFile(fileName)) continue;
      callers.push({
        name: call.from.name,
        snapshot: await this.snapshotOfItem(
          call.from,
          this.sitesFromRanges(fileName, call.fromRanges),
          "contextIfLarge",
        ),
        decl: this.declOfItem(call.from),
      });
    }

    const callees: RelationEntry[] = [];
    const itemFile = fileURLToPath(item.uri);
    for (const call of outgoing ?? []) {
      const fileName = fileURLToPath(call.to.uri);
      if (!this.isProjectFile(fileName)) continue;
      callees.push({
        name: call.to.name,
        // fromRanges for outgoing calls live in the target function's file.
        snapshot: await this.snapshotOfItem(
          call.to,
          this.sitesFromRanges(itemFile, call.fromRanges),
          "full",
        ),
        decl: this.declOfItem(call.to),
      });
    }

    return {
      targetName: item.name,
      target: await this.snapshotOfItem(item, [], "full"),
      callers,
      callees,
    };
  }

  async snapshotAt(decl: DeclRef): Promise<FunctionSnapshot | null> {
    const item = await this.prepare(decl);
    return item ? await this.snapshotOfItem(item, [], "full") : null;
  }

  async fileInfo(
    relativePath: string,
  ): Promise<{ lines: string[]; symbols: SymbolRange[] } | null> {
    const fileName = path.join(this.rootDir, relativePath);
    const lines = this.linesOf(fileName);
    if (!lines.length) return null;
    const documentSymbols = await this.docSymbols(fileName);
    const symbols: SymbolRange[] = [];
    const flatten = (list: LspDocumentSymbol[]): void => {
      for (const symbol of list) {
        const kind = SYMBOL_KIND_NAMES[symbol.kind];
        if (kind) {
          symbols.push({
            name: symbol.name,
            kind,
            startLine: symbol.range.start.line + 1,
            endLine: symbol.range.end.line + 1,
          });
        }
        if (symbol.children) flatten(symbol.children);
      }
    };
    flatten(documentSymbols);
    return { lines, symbols };
  }

  dispose(): void {
    void this.client?.dispose();
    this.client = null;
    this.ready = null;
  }
}
