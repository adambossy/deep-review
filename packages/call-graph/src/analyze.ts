import type {
  DeclRef,
  FunctionRelations,
  LanguageBackend,
} from "./backend.js";
import {
  changedPaths,
  fetchPrInfo,
  hunksOverlapping,
  parsePrUrl,
  parseUnifiedDiff,
  prepareCheckouts,
} from "@deep-review/pr";
import { mergeGraphs, walkCallGraph, type SideGraph } from "./graph.js";
import { detectRenamedDeclarations, renamedCounterparts } from "./rename.js";
import { LspBackend, pyrightConfig } from "./lspBackend.js";
import { TsBackend } from "./tsBackend.js";
import type {
  CallGraphResult,
  CallPathResult,
  DiffHunk,
  EmbeddedFile,
  FileDiff,
  FunctionSnapshot,
  RelatedFunction,
} from "./types.js";

export interface AnalyzeOptions {
  prUrl: string;
  functionName: string;
  /** Where to cache the clone + worktrees. Defaults to a per-PR tmp dir. */
  workDir?: string;
}

interface PrContext {
  info: Awaited<ReturnType<typeof fetchPrInfo>>;
  baseDir: string;
  /** The commit the PR branched from; what baseDir is checked out at. */
  mergeBaseSha: string;
  headDir: string;
  files: FileDiff[];
  preferred: Set<string>;
}

async function preparePr(options: AnalyzeOptions): Promise<PrContext> {
  const ref = parsePrUrl(options.prUrl);
  const info = await fetchPrInfo(ref);
  const { baseDir, headDir, mergeBaseSha, diffText } = prepareCheckouts(
    info,
    options.workDir,
  );
  const files = parseUnifiedDiff(diffText);
  return {
    info,
    baseDir,
    mergeBaseSha,
    headDir,
    files,
    preferred: changedPaths(files),
  };
}

/**
 * Candidate language backends for one checkout, ordered by which language
 * the PR's diff actually touches. Each backend starts lazily on first use.
 */
function createBackends(dir: string, changed: ReadonlySet<string>): LanguageBackend[] {
  const paths = [...changed];
  const hasPython = paths.some((p) => p.endsWith(".py"));
  const hasTypeScript = paths.some((p) => /\.(ts|tsx|mts|cts|js|jsx)$/.test(p));
  if (hasPython && !hasTypeScript) {
    return [new LspBackend(dir, pyrightConfig()), new TsBackend(dir)];
  }
  if (hasPython) {
    return [new TsBackend(dir), new LspBackend(dir, pyrightConfig())];
  }
  return [new TsBackend(dir)];
}

interface FoundBackend {
  backend: LanguageBackend;
  decl: DeclRef;
}

async function findAcrossBackends(
  backends: LanguageBackend[],
  name: string,
  preferred: ReadonlySet<string>,
): Promise<FoundBackend | null> {
  for (const backend of backends) {
    const decl = await backend.findFunction(name, preferred).catch(() => null);
    if (decl) return { backend, decl };
  }
  return null;
}

interface FoundFunction extends FoundBackend {
  /** The name the function has on this side (differs when the PR renamed it). */
  name: string;
}

/**
 * Locate `name` on one side of the PR, falling back to the name it had (or
 * gained) across a rename visible in the diff — so the "before" side of a
 * renamed function is still found and walked.
 */
async function findWithRenames(
  backends: LanguageBackend[],
  name: string,
  preferred: ReadonlySet<string>,
  files: FileDiff[],
  side: "old" | "new",
): Promise<FoundFunction | null> {
  const direct = await findAcrossBackends(backends, name, preferred);
  if (direct) return { ...direct, name };
  for (const counterpart of renamedCounterparts(files, name, side)) {
    const found = await findAcrossBackends(backends, counterpart, preferred);
    if (found) return { ...found, name: counterpart };
  }
  return null;
}

function hunksForSnapshot(
  files: FileDiff[],
  side: "old" | "new",
  snapshot: FunctionSnapshot | null,
): DiffHunk[] {
  if (!snapshot) return [];
  const pathKey = side === "old" ? "oldPath" : "newPath";
  const file = files.find((f) => f[pathKey] === snapshot.file);
  if (!file) return [];
  return hunksOverlapping(file, side, snapshot.startLine, snapshot.endLine);
}

function mergeHunks(...groups: DiffHunk[][]): DiffHunk[] {
  const seen = new Set<string>();
  const merged: DiffHunk[] = [];
  for (const hunk of groups.flat()) {
    if (seen.has(hunk.header)) continue;
    seen.add(hunk.header);
    merged.push(hunk);
  }
  return merged;
}

function mergeSides(
  files: FileDiff[],
  before: Array<{ name: string; snapshot: FunctionSnapshot }>,
  after: Array<{ name: string; snapshot: FunctionSnapshot }>,
): RelatedFunction[] {
  const byKey = new Map<string, RelatedFunction>();

  const upsert = (
    side: "before" | "after",
    entry: { name: string; snapshot: FunctionSnapshot },
  ) => {
    const key = `${entry.snapshot.file} ${entry.name}`;
    let fn = byKey.get(key);
    if (!fn) {
      fn = {
        name: entry.name,
        file: entry.snapshot.file,
        presence: side,
        before: null,
        after: null,
        hunks: [],
        changedInPr: false,
      };
      byKey.set(key, fn);
    }
    fn[side] = entry.snapshot;
    fn.presence = fn.before && fn.after ? "both" : side;
  };

  for (const entry of before) upsert("before", entry);
  for (const entry of after) upsert("after", entry);

  // Fold each rename's before-only half into its after-only half.
  for (const pair of detectRenamedDeclarations(files)) {
    const oldEntry = byKey.get(`${pair.oldFile} ${pair.oldName}`);
    const newEntry = byKey.get(`${pair.newFile} ${pair.newName}`);
    if (!oldEntry?.before || oldEntry.after || !newEntry?.after || newEntry.before) {
      continue;
    }
    newEntry.before = oldEntry.before;
    newEntry.presence = "both";
    newEntry.renamedFrom = pair.oldName;
    byKey.delete(`${pair.oldFile} ${pair.oldName}`);
  }

  for (const fn of byKey.values()) {
    fn.hunks = mergeHunks(
      hunksForSnapshot(files, "old", fn.before),
      hunksForSnapshot(files, "new", fn.after),
    );
    fn.changedInPr = fn.hunks.length > 0 || fn.presence !== "both";
  }

  return [...byKey.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
  );
}

async function embedFiles(
  backend: LanguageBackend,
  side: "before" | "after",
  paths: Iterable<string>,
): Promise<EmbeddedFile[]> {
  const embedded: EmbeddedFile[] = [];
  for (const p of new Set(paths)) {
    const file = await backend.fileInfo(p).catch(() => null);
    if (file) embedded.push({ side, path: p, ...file });
  }
  return embedded;
}

/**
 * Analyze how a function relates to the rest of the codebase on both sides
 * of a PR: its callers and callees before and after, each annotated with
 * the PR diff hunks that touch them.
 */
export async function analyzePrCallGraph(
  options: AnalyzeOptions,
): Promise<CallGraphResult> {
  const { info, baseDir, mergeBaseSha, headDir, files, preferred } =
    await preparePr(options);

  const allBackends: LanguageBackend[] = [];
  try {
    const sideFor = async (
      dir: string,
      side: "old" | "new",
    ): Promise<{ backend: LanguageBackend; relations: FunctionRelations } | null> => {
      const backends = createBackends(dir, preferred);
      allBackends.push(...backends);
      const found = await findWithRenames(
        backends,
        options.functionName,
        preferred,
        files,
        side,
      );
      if (!found) return null;
      const relations = await found.backend.relationsAt(found.decl);
      return relations ? { backend: found.backend, relations } : null;
    };

    const baseSide = await sideFor(baseDir, "old");
    const headSide = await sideFor(headDir, "new");
    const before = baseSide?.relations ?? null;
    const after = headSide?.relations ?? null;
    if (!before && !after) {
      throw new Error(
        `Function "${options.functionName}" was not found in either revision of ${info.owner}/${info.repo}`,
      );
    }

    // Embed the target's and callers' files whole, so the HTML report can
    // expand context around what's initially shown.
    const embedded: EmbeddedFile[] = [];
    for (const [side, data] of [
      ["before", baseSide],
      ["after", headSide],
    ] as const) {
      if (!data) continue;
      embedded.push(
        ...(await embedFiles(data.backend, side, [
          data.relations.target.file,
          ...data.relations.callers.map((c) => c.snapshot.file),
        ])),
      );
    }

    return {
      prUrl: options.prUrl,
      prTitle: info.title,
      functionName: options.functionName,
      base: { ref: info.baseRef, sha: mergeBaseSha },
      head: { ref: `pull/${info.number}/head`, sha: info.headSha },
      target: {
        name: options.functionName,
        ...(before && after && before.targetName !== after.targetName
          ? { renamedFrom: before.targetName }
          : {}),
        before: before?.target ?? null,
        after: after?.target ?? null,
        hunks: mergeHunks(
          hunksForSnapshot(files, "old", before?.target ?? null),
          hunksForSnapshot(files, "new", after?.target ?? null),
        ),
        changedInPr:
          hunksForSnapshot(files, "old", before?.target ?? null).length > 0 ||
          hunksForSnapshot(files, "new", after?.target ?? null).length > 0,
      },
      callers: mergeSides(files, before?.callers ?? [], after?.callers ?? []),
      callees: mergeSides(files, before?.callees ?? [], after?.callees ?? []),
      files: embedded,
    };
  } finally {
    for (const backend of allBackends) backend.dispose();
  }
}

export interface PathOptions extends AnalyzeOptions {
  /** How many changed functions deep to walk in each direction (default 8). */
  maxDepth?: number;
}

/**
 * Recursively walk the call graph out from the named function on both sides
 * of the PR, expanding through changed functions until hitting unchanged
 * boundaries. Returns a graph of nodes and caller→callee edges that a
 * navigator UI can traverse in either direction.
 */
export async function analyzePrCallPath(
  options: PathOptions,
): Promise<CallPathResult> {
  const { info, baseDir, mergeBaseSha, headDir, files, preferred } =
    await preparePr(options);
  const limits = {
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
  };

  const allBackends: LanguageBackend[] = [];
  try {
    const sideFor = async (
      dir: string,
      side: "old" | "new",
    ): Promise<{ backend: LanguageBackend; graph: SideGraph } | null> => {
      const backends = createBackends(dir, preferred);
      allBackends.push(...backends);
      const found = await findWithRenames(
        backends,
        options.functionName,
        preferred,
        files,
        side,
      );
      if (!found) return null;
      const graph = await walkCallGraph(found.backend, found.decl, files, side, limits);
      return { backend: found.backend, graph };
    };

    const baseSide = await sideFor(baseDir, "old");
    const headSide = await sideFor(headDir, "new");
    if (!baseSide && !headSide) {
      throw new Error(
        `Function "${options.functionName}" was not found in either revision of ${info.owner}/${info.repo}`,
      );
    }

    const { rootId, nodes, edges } = mergeGraphs(
      files,
      baseSide?.graph ?? null,
      headSide?.graph ?? null,
    );

    // Embed every node's file so panels can expand context anywhere.
    const embedded: EmbeddedFile[] = [];
    for (const [side, data] of [
      ["before", baseSide],
      ["after", headSide],
    ] as const) {
      if (!data) continue;
      embedded.push(
        ...(await embedFiles(
          data.backend,
          side,
          [...data.graph.nodes.values()].map((n) => n.snapshot.file),
        )),
      );
    }

    return {
      prUrl: options.prUrl,
      prTitle: info.title,
      functionName: options.functionName,
      base: { ref: info.baseRef, sha: mergeBaseSha },
      head: { ref: `pull/${info.number}/head`, sha: info.headSha },
      rootId,
      nodes,
      edges,
      files: embedded,
    };
  } finally {
    for (const backend of allBackends) backend.dispose();
  }
}
