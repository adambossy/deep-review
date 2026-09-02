import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  callSitesFromRanges,
  extractSource,
  type DeclRef,
  type DefinitionLocation,
  type EnclosingDeclaration,
  type FunctionRelations,
  type IncomingReference,
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
  /** The name's own range, inside `range`. */
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}
interface LspLocation {
  uri: string;
  range: LspRange;
}
interface LspLocationLink {
  targetUri: string;
  /** Whole declaration. */
  targetRange: LspRange;
  /** The declared name. */
  targetSelectionRange: LspRange;
}

/** LSP SymbolKind → the kind names the rest of the report uses. */
const SYMBOL_KIND_NAMES: Record<number, string> = {
  2: "module",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
};

/** Kinds that name a scope worth a breadcrumb; variables and fields are not. */
const SCOPE_KINDS = new Set([5, 6, 9, 11, 12]);

function contains(range: LspRange, pos: LspPosition): boolean {
  return (
    (range.start.line < pos.line ||
      (range.start.line === pos.line && range.start.character <= pos.character)) &&
    (range.end.line > pos.line ||
      (range.end.line === pos.line && range.end.character >= pos.character))
  );
}

/** Innermost document symbol whose range contains `pos`. */
function deepestSymbol(symbols: LspDocumentSymbol[], pos: LspPosition): LspDocumentSymbol | null {
  for (const symbol of symbols) {
    if (!contains(symbol.range, pos)) continue;
    return (symbol.children && deepestSymbol(symbol.children, pos)) ?? symbol;
  }
  return null;
}

/** Innermost callable containing `pos`, else the innermost class, else null. */
function enclosingScope(symbols: LspDocumentSymbol[], pos: LspPosition): LspDocumentSymbol | null {
  let cls: LspDocumentSymbol | null = null;
  let fn: LspDocumentSymbol | null = null;
  const walk = (list: LspDocumentSymbol[]): void => {
    for (const symbol of list) {
      if (!contains(symbol.range, pos)) continue;
      if (CALLABLE_KINDS.has(symbol.kind)) fn = symbol;
      else if (symbol.kind === 5) cls = symbol;
      if (symbol.children) walk(symbol.children);
    }
  };
  walk(symbols);
  return fn ?? cls;
}

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

/**
 * Whether the 0-based `line` belongs to an import statement — a line that
 * brings a name into scope without using it. The statement may start
 * earlier: a parenthesized or backslash-continued import spans several
 * lines, each naming one binding.
 */
export function isImportStatement(lines: readonly string[], line: number): boolean {
  const opensImport = /^\s*(from\s+\S+\s+import\b|import\b)/;
  for (let n = line; n >= 0; n--) {
    if (opensImport.test(lines[n] ?? "")) return true;
    const previous = (lines[n - 1] ?? "").replace(/#.*$/, "").trimEnd();
    if (!/[(,\\]$/.test(previous)) return false;
  }
  return false;
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
    const found = deepestSymbol(
      await this.docSymbols(fileURLToPath(item.uri)),
      item.selectionRange.start,
    )?.range;
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
    await client.whenIdle();

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
    file: string,
  ): Promise<{ lines: string[]; symbols: SymbolRange[] } | null> {
    const fileName = path.resolve(this.rootDir, file);
    const lines = this.linesOf(fileName);
    if (!lines.length) return null;
    const documentSymbols = await this.docSymbols(fileName);
    // Keep the server's nesting; a symbol of a kind we do not name (a
    // variable holding a class, say) hands its children up to its parent.
    const convert = (list: LspDocumentSymbol[]): SymbolRange[] => {
      const out: SymbolRange[] = [];
      for (const symbol of list) {
        const children = symbol.children ? convert(symbol.children) : [];
        if (!SCOPE_KINDS.has(symbol.kind)) {
          out.push(...children);
          continue;
        }
        const sel = symbol.selectionRange ?? symbol.range;
        out.push({
          name: symbol.name,
          kind: SYMBOL_KIND_NAMES[symbol.kind]!,
          startLine: symbol.range.start.line + 1,
          endLine: symbol.range.end.line + 1,
          nameLine: sel.start.line + 1,
          nameColumn: sel.start.character,
          nameEndColumn:
            sel.end.line === sel.start.line ? sel.end.character : sel.start.character + symbol.name.length,
          ...(children.length ? { children } : {}),
        });
      }
      return out;
    };
    return { lines, symbols: convert(documentSymbols) };
  }

  async definitionAt(ref: DeclRef): Promise<DefinitionLocation | null> {
    const client = await this.start();
    await this.open(client, ref.fileName);
    const raw = await client.request<LspLocation | LspLocation[] | LspLocationLink[] | null>(
      "textDocument/definition",
      {
        textDocument: { uri: pathToFileURL(ref.fileName).href },
        position: { line: ref.line - 1, character: ref.column },
      },
    );
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (!first) return null;

    // Normalise Location vs LocationLink. A plain Location only names the
    // identifier; the declaration's extent then comes from document symbols.
    const uri = "targetUri" in first ? first.targetUri : first.uri;
    const nameRange = "targetSelectionRange" in first ? first.targetSelectionRange : first.range;
    const fileName = fileURLToPath(uri);
    const self =
      fileName === ref.fileName &&
      nameRange.start.line === ref.line - 1 &&
      nameRange.start.character <= ref.column &&
      ref.column <= nameRange.end.character;

    const symbol = deepestSymbol(await this.docSymbols(fileName), nameRange.start);
    const extent =
      "targetRange" in first ? first.targetRange : (symbol?.range ?? nameRange);
    const lineText = this.linesOf(fileName)[nameRange.start.line] ?? "";
    const name =
      nameRange.end.line === nameRange.start.line
        ? lineText.slice(nameRange.start.character, nameRange.end.character)
        : (symbol?.name ?? "");
    // The deepest enclosing symbol names the declaration only when its own
    // name sits at the target; otherwise the target is a variable or
    // parameter inside that symbol.
    const kind =
      symbol && contains(symbol.selectionRange ?? symbol.range, nameRange.start)
        ? SYMBOL_KIND_NAMES[symbol.kind] ?? "variable"
        : "variable";
    return {
      fileName,
      name,
      kind,
      external: !this.isProjectFile(fileName),
      self,
      nameLine: nameRange.start.line + 1,
      nameColumn: nameRange.start.character,
      nameEndColumn:
        nameRange.end.line === nameRange.start.line
          ? nameRange.end.character
          : nameRange.start.character + name.length,
      startLine: extent.start.line + 1,
      endLine: extent.end.line + 1,
    };
  }

  private async referenceAt(uri: string, range: LspRange): Promise<IncomingReference> {
    const fileName = fileURLToPath(uri);
    const lineText = this.linesOf(fileName)[range.start.line] ?? "";
    const scope = enclosingScope(await this.docSymbols(fileName), range.start);
    let enclosing: EnclosingDeclaration | null = null;
    if (scope) {
      const sel = scope.selectionRange ?? scope.range;
      enclosing = {
        fileName,
        line: sel.start.line + 1,
        column: sel.start.character,
        name: scope.name,
        kind: SYMBOL_KIND_NAMES[scope.kind] ?? "function",
        startLine: scope.range.start.line + 1,
        endLine: scope.range.end.line + 1,
      };
    }
    return {
      fileName,
      line: range.start.line + 1,
      startColumn: range.start.character,
      endColumn: range.end.line === range.start.line ? range.end.character : lineText.length,
      snippet: lineText.trim(),
      enclosing,
    };
  }

  async incomingCallsAt(ref: DeclRef): Promise<IncomingReference[] | null> {
    const client = await this.start();
    const item = await this.prepare(ref);
    if (!item) return null;
    // Cross-file: only sees callers in files pyright's background scan has
    // reached, so a query racing that scan can under-report real callers.
    await client.whenIdle();
    const incoming = await client.request<Array<{ from: LspCallHierarchyItem; fromRanges: LspRange[] }> | null>(
      "callHierarchy/incomingCalls",
      { item },
    );
    const refs: IncomingReference[] = [];
    for (const call of incoming ?? []) {
      if (!this.isProjectFile(fileURLToPath(call.from.uri))) continue;
      for (const range of call.fromRanges) refs.push(await this.referenceAt(call.from.uri, range));
    }
    return refs;
  }

  async referencesAt(ref: DeclRef): Promise<IncomingReference[]> {
    const client = await this.start();
    await this.open(client, ref.fileName);
    // Cross-file, same as incomingCallsAt above: wait out the background scan.
    await client.whenIdle();
    const locations = await client.request<LspLocation[] | null>("textDocument/references", {
      textDocument: { uri: pathToFileURL(ref.fileName).href },
      position: { line: ref.line - 1, character: ref.column },
      context: { includeDeclaration: false },
    });
    const refs: IncomingReference[] = [];
    for (const loc of locations ?? []) {
      const fileName = fileURLToPath(loc.uri);
      if (!this.isProjectFile(fileName)) continue;
      if (isImportStatement(this.linesOf(fileName), loc.range.start.line)) continue;
      refs.push(await this.referenceAt(loc.uri, loc.range));
    }
    return refs;
  }

  dispose(): void {
    void this.client?.dispose();
    this.client = null;
    this.ready = null;
  }
}
