import path from "node:path";
import ts from "typescript";
import {
  extractSource,
  type DeclRef,
  type DefinitionLocation,
  type EnclosingDeclaration,
  type FunctionRelations,
  type IncomingReference,
} from "./backend.js";
import type { CallSite, FunctionSnapshot, SymbolRange } from "./types.js";

export type { FunctionRelations, RelationEntry } from "./backend.js";

export interface ProjectService {
  rootDir: string;
  service: ts.LanguageService;
  program: ts.Program;
}

export interface FoundFunction {
  fileName: string;
  /** Repo-relative path with forward slashes. */
  relativeFile: string;
  /** Offset of the function's name identifier. */
  namePos: number;
}

const EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
];

const FALLBACK_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  strict: false,
  skipLibCheck: true,
  noEmit: true,
};

/**
 * Stand up a TypeScript language service over a checkout. File list comes
 * from walking the tree (so callers outside the root tsconfig's `include`
 * are still found); compiler options come from the repo's tsconfig when
 * one exists.
 */
export function createProjectService(rootDir: string): ProjectService {
  const fileNames = ts.sys.readDirectory(
    rootDir,
    [".ts", ".tsx", ".mts", ".cts"],
    EXCLUDES,
    ["**/*"],
  );

  let options = FALLBACK_OPTIONS;
  const configPath = ts.findConfigFile(rootDir, ts.sys.fileExists, "tsconfig.json");
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.config) {
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        path.dirname(configPath),
      );
      options = { ...parsed.options, noEmit: true };
    }
  }

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => fileNames,
    getScriptVersion: () => "1",
    getScriptSnapshot: (file) => {
      const text = ts.sys.readFile(file);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => rootDir,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const program = service.getProgram();
  if (!program) throw new Error(`Could not create TS program for ${rootDir}`);
  return { rootDir, service, program };
}

function toRelative(rootDir: string, fileName: string): string {
  return path.relative(rootDir, fileName).split(path.sep).join("/");
}

function isProjectFile(rootDir: string, fileName: string): boolean {
  return (
    !fileName.includes("/node_modules/") &&
    !fileName.endsWith(".d.ts") &&
    !path.relative(rootDir, fileName).startsWith("..")
  );
}

function nameMatches(node: ts.Identifier | ts.PrivateIdentifier, name: string): boolean {
  return node.text === name || node.text === `#${name}`;
}

function namePositionsInFile(sourceFile: ts.SourceFile, name: string): number[] {
  const positions: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) &&
      nameMatches(node.name, name)
    ) {
      positions.push(node.name.getStart(sourceFile));
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      nameMatches(node.name, name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      positions.push(node.name.getStart(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return positions;
}

/**
 * Locate a function declaration by name. When the name is declared in
 * several files, one declared in `preferredFiles` (the PR's changed
 * files) wins; otherwise the first match is used.
 */
export function findFunction(
  ps: ProjectService,
  name: string,
  preferredFiles: ReadonlySet<string>,
): FoundFunction | null {
  const matches: FoundFunction[] = [];
  for (const sourceFile of ps.program.getSourceFiles()) {
    if (!isProjectFile(ps.rootDir, sourceFile.fileName)) continue;
    for (const namePos of namePositionsInFile(sourceFile, name)) {
      matches.push({
        fileName: sourceFile.fileName,
        relativeFile: toRelative(ps.rootDir, sourceFile.fileName),
        namePos,
      });
    }
  }
  if (matches.length === 0) return null;
  return matches.find((m) => preferredFiles.has(m.relativeFile)) ?? matches[0]!;
}

function snapshotFromItem(
  ps: ProjectService,
  item: ts.CallHierarchyItem,
  callSites: CallSite[],
  sourceMode: "full" | "contextIfLarge",
): FunctionSnapshot | null {
  const sourceFile = ps.program.getSourceFile(item.file);
  if (!sourceFile) return null;
  const start = sourceFile.getLineAndCharacterOfPosition(item.span.start);
  const end = sourceFile.getLineAndCharacterOfPosition(
    item.span.start + item.span.length,
  );
  const startLine = start.line + 1;
  const endLine = end.line + 1;
  return {
    file: toRelative(ps.rootDir, item.file),
    startLine,
    endLine,
    callSites,
    ...extractSource(sourceFile.text.split("\n"), startLine, endLine, callSites, sourceMode),
  };
}

/** Line/column of an item's name identifier, as a DeclRef. */
function declOfItem(ps: ProjectService, item: ts.CallHierarchyItem): DeclRef {
  const sourceFile = ps.program.getSourceFile(item.file);
  const lc = sourceFile
    ? sourceFile.getLineAndCharacterOfPosition(item.selectionSpan.start)
    : { line: 0, character: 0 };
  return { fileName: item.file, line: lc.line + 1, column: lc.character };
}

function callSitesFromSpans(
  ps: ProjectService,
  file: string,
  spans: readonly ts.TextSpan[],
): CallSite[] {
  const sourceFile = ps.program.getSourceFile(file);
  if (!sourceFile) return [];
  const lines = sourceFile.text.split("\n");
  const seen = new Set<number>();
  const sites: CallSite[] = [];
  for (const span of spans) {
    const start = sourceFile.getLineAndCharacterOfPosition(span.start);
    const end = sourceFile.getLineAndCharacterOfPosition(span.start + span.length);
    const line = start.line + 1;
    if (seen.has(line)) continue;
    seen.add(line);
    const lineText = lines[line - 1] ?? "";
    sites.push({
      line,
      snippet: lineText.trim(),
      startColumn: start.character,
      endColumn: end.line === start.line ? end.character : lineText.length,
    });
  }
  return sites;
}

const SYMBOL_KINDS: Array<[check: (n: ts.Node) => boolean, kind: string]> = [
  [ts.isClassDeclaration, "class"],
  [ts.isInterfaceDeclaration, "interface"],
  [ts.isEnumDeclaration, "enum"],
  [ts.isModuleDeclaration, "namespace"],
  [ts.isFunctionDeclaration, "function"],
  [ts.isMethodDeclaration, "method"],
  [ts.isGetAccessorDeclaration, "accessor"],
  [ts.isSetAccessorDeclaration, "accessor"],
];

function collectSymbols(sourceFile: ts.SourceFile): SymbolRange[] {
  const symbols: SymbolRange[] = [];
  const push = (node: ts.Node, nameNode: ts.Node | undefined, name: string, kind: string) => {
    const symbol: SymbolRange = {
      name,
      kind,
      startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
    };
    if (nameNode) {
      const start = sourceFile.getLineAndCharacterOfPosition(nameNode.getStart(sourceFile));
      const end = sourceFile.getLineAndCharacterOfPosition(nameNode.getEnd());
      symbol.nameLine = start.line + 1;
      symbol.nameColumn = start.character;
      symbol.nameEndColumn = end.line === start.line ? end.character : start.character + name.length;
    }
    symbols.push(symbol);
  };
  const visit = (node: ts.Node): void => {
    const match = SYMBOL_KINDS.find(([check]) => check(node));
    if (match) {
      const named = node as ts.NamedDeclaration;
      if (named.name) push(node, named.name, named.name.getText(sourceFile), match[1]);
    } else if (ts.isConstructorDeclaration(node)) {
      push(node, undefined, "constructor", "constructor");
    } else if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      push(node, node.name, node.name.getText(sourceFile), "function");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return symbols;
}

/**
 * Full line content + declared symbols of one file. Repo-relative paths are
 * resolved against the root; an absolute path (an external definition's
 * `.d.ts`) is used as-is, since the program holds those too.
 */
export function fileSnapshot(
  ps: ProjectService,
  file: string,
): { lines: string[]; symbols: SymbolRange[] } | null {
  const sourceFile = ps.program.getSourceFile(path.resolve(ps.rootDir, file));
  if (!sourceFile) return null;
  return { lines: sourceFile.text.split("\n"), symbols: collectSymbols(sourceFile) };
}

/** The name node of a declaration that can enclose code, or undefined. */
function scopeName(node: ts.Node): ts.Node | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node)
  ) {
    return node.name;
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    (ts.isVariableDeclaration(node.parent) || ts.isPropertyDeclaration(node.parent))
  ) {
    return node.parent.name;
  }
  return undefined;
}

/** The innermost named function (else class) containing `pos`. */
function enclosingAt(sourceFile: ts.SourceFile, pos: number): EnclosingDeclaration | null {
  let node: ts.Node = sourceFile;
  for (;;) {
    const child = ts.forEachChild(node, (c) => (c.getStart(sourceFile) <= pos && pos < c.getEnd() ? c : undefined));
    if (!child) break;
    node = child;
  }
  let fn: ts.Node | null = null;
  let cls: ts.Node | null = null;
  for (let n: ts.Node | undefined = node; n && !fn; n = n.parent) {
    const name = scopeName(n);
    if (!name) continue;
    if (ts.isClassDeclaration(n)) cls ??= n;
    else fn = n;
  }
  const scope = fn ?? cls;
  const name = scope && scopeName(scope);
  if (!scope || !name) return null;
  const decl = ts.isArrowFunction(scope) || ts.isFunctionExpression(scope) ? scope.parent : scope;
  const lc = sourceFile.getLineAndCharacterOfPosition(name.getStart(sourceFile));
  return {
    fileName: sourceFile.fileName,
    line: lc.line + 1,
    column: lc.character,
    name: name.getText(sourceFile),
    kind: ts.isClassDeclaration(scope) ? "class" : ts.isMethodDeclaration(scope) ? "method" : "function",
    startLine: sourceFile.getLineAndCharacterOfPosition(decl.getStart(sourceFile)).line + 1,
    endLine: sourceFile.getLineAndCharacterOfPosition(decl.getEnd()).line + 1,
  };
}

function referenceAt(ps: ProjectService, fileName: string, span: ts.TextSpan): IncomingReference | null {
  const sourceFile = ps.program.getSourceFile(fileName);
  if (!sourceFile) return null;
  const start = sourceFile.getLineAndCharacterOfPosition(span.start);
  const end = sourceFile.getLineAndCharacterOfPosition(span.start + span.length);
  const lineText = sourceFile.text.split("\n")[start.line] ?? "";
  return {
    fileName,
    line: start.line + 1,
    startColumn: start.character,
    endColumn: end.line === start.line ? end.character : lineText.length,
    snippet: lineText.trim(),
    enclosing: enclosingAt(sourceFile, span.start),
  };
}

/** Call sites of the callable at `pos`; null when nothing callable is there. */
export function incomingCallsAt(
  ps: ProjectService,
  fileName: string,
  pos: number,
): IncomingReference[] | null {
  const prepared = ps.service.prepareCallHierarchy(fileName, pos);
  const item = Array.isArray(prepared) ? prepared[0] : prepared;
  if (!item) return null;
  const refs: IncomingReference[] = [];
  for (const incoming of ps.service.provideCallHierarchyIncomingCalls(item.file, item.selectionSpan.start)) {
    if (!isProjectFile(ps.rootDir, incoming.from.file)) continue;
    for (const span of incoming.fromSpans) {
      const ref = referenceAt(ps, incoming.from.file, span);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

/** Uses of the symbol at `pos` across the project, excluding its declaration. */
export function referencesAt(ps: ProjectService, fileName: string, pos: number): IncomingReference[] {
  const refs: IncomingReference[] = [];
  for (const symbol of ps.service.findReferences(fileName, pos) ?? []) {
    for (const entry of symbol.references) {
      if (entry.isDefinition || !isProjectFile(ps.rootDir, entry.fileName)) continue;
      const ref = referenceAt(ps, entry.fileName, entry.textSpan);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

/**
 * Where the symbol at `pos` is declared. Null when the language service has
 * no answer, or when `pos` sits on the declaration itself — the reader is
 * already looking at it.
 */
export function definitionAt(
  ps: ProjectService,
  fileName: string,
  pos: number,
): DefinitionLocation | null {
  const defs = ps.service.getDefinitionAtPosition(fileName, pos);
  const def = defs?.[0];
  if (!def) return null;
  const target = ps.program.getSourceFile(def.fileName);
  if (!target) return null;
  const isSelf =
    def.fileName === fileName &&
    def.textSpan.start <= pos &&
    pos <= def.textSpan.start + def.textSpan.length;
  if (isSelf) return null;

  const nameStart = target.getLineAndCharacterOfPosition(def.textSpan.start);
  const nameEnd = target.getLineAndCharacterOfPosition(def.textSpan.start + def.textSpan.length);
  const extent = def.contextSpan ?? def.textSpan;
  const start = target.getLineAndCharacterOfPosition(extent.start);
  const end = target.getLineAndCharacterOfPosition(extent.start + extent.length);
  return {
    fileName: def.fileName,
    name: def.name,
    kind: def.kind,
    external: !isProjectFile(ps.rootDir, def.fileName),
    nameLine: nameStart.line + 1,
    nameColumn: nameStart.character,
    nameEndColumn:
      nameEnd.line === nameStart.line ? nameEnd.character : nameStart.character + def.name.length,
    startLine: start.line + 1,
    endLine: end.line + 1,
  };
}

/** Callers (incoming calls) and callees (outgoing calls) of one function. */
export function getRelationsAt(
  ps: ProjectService,
  fileName: string,
  namePos: number,
): FunctionRelations | null {
  const prepared = ps.service.prepareCallHierarchy(fileName, namePos);
  const item = Array.isArray(prepared) ? prepared[0] : prepared;
  if (!item) return null;

  const target = snapshotFromItem(ps, item, [], "full");
  if (!target) return null;

  const callers: FunctionRelations["callers"] = [];
  for (const incoming of ps.service.provideCallHierarchyIncomingCalls(
    item.file,
    item.selectionSpan.start,
  )) {
    if (!isProjectFile(ps.rootDir, incoming.from.file)) continue;
    const snapshot = snapshotFromItem(
      ps,
      incoming.from,
      callSitesFromSpans(ps, incoming.from.file, incoming.fromSpans),
      "contextIfLarge",
    );
    if (snapshot) {
      callers.push({
        name: incoming.from.name,
        snapshot,
        decl: declOfItem(ps, incoming.from),
      });
    }
  }

  const callees: FunctionRelations["callees"] = [];
  for (const outgoing of ps.service.provideCallHierarchyOutgoingCalls(
    item.file,
    item.selectionSpan.start,
  )) {
    if (!isProjectFile(ps.rootDir, outgoing.to.file)) continue;
    // fromSpans for outgoing calls live in the *target* function's file.
    const callSites = callSitesFromSpans(ps, item.file, outgoing.fromSpans);
    // The callee body itself contains no call sites, so always show it whole.
    const snapshot = snapshotFromItem(ps, outgoing.to, callSites, "full");
    if (snapshot) {
      callees.push({
        name: outgoing.to.name,
        snapshot,
        decl: declOfItem(ps, outgoing.to),
      });
    }
  }

  return { targetName: item.name, target, callers, callees };
}

export function getRelations(
  ps: ProjectService,
  fn: FoundFunction,
): FunctionRelations | null {
  return getRelationsAt(ps, fn.fileName, fn.namePos);
}

/** 1-based line and 0-based column of a position in a file. */
export function lineColumnAt(
  ps: ProjectService,
  fileName: string,
  pos: number,
): { line: number; column: number } | null {
  const sourceFile = ps.program.getSourceFile(fileName);
  if (!sourceFile) return null;
  const lc = sourceFile.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, column: lc.character };
}

/** Full-source snapshot of the function declared at a position. */
export function snapshotAt(
  ps: ProjectService,
  fileName: string,
  namePos: number,
): FunctionSnapshot | null {
  const prepared = ps.service.prepareCallHierarchy(fileName, namePos);
  const item = Array.isArray(prepared) ? prepared[0] : prepared;
  return item ? snapshotFromItem(ps, item, [], "full") : null;
}
