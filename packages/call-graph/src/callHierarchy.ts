import path from "node:path";
import ts from "typescript";
import {
  extractSource,
  type DeclRef,
  type FunctionRelations,
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
  const push = (node: ts.Node, name: string, kind: string) => {
    symbols.push({
      name,
      kind,
      startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
    });
  };
  const visit = (node: ts.Node): void => {
    const match = SYMBOL_KINDS.find(([check]) => check(node));
    if (match) {
      const named = node as ts.NamedDeclaration;
      if (named.name) push(node, named.name.getText(sourceFile), match[1]);
    } else if (ts.isConstructorDeclaration(node)) {
      push(node, "constructor", "constructor");
    } else if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      push(node, node.name.getText(sourceFile), "function");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return symbols;
}

/** Full line content + declared symbols of one repo-relative file. */
export function fileSnapshot(
  ps: ProjectService,
  relativeFile: string,
): { lines: string[]; symbols: SymbolRange[] } | null {
  const sourceFile = ps.program.getSourceFile(path.join(ps.rootDir, relativeFile));
  if (!sourceFile) return null;
  return { lines: sourceFile.text.split("\n"), symbols: collectSymbols(sourceFile) };
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
