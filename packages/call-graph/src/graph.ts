import type { DeclRef, LanguageBackend, RelationEntry } from "./backend.js";
import { hunksForFileRange } from "@deep-review/pr";
import type {
  CallSite,
  DiffHunk,
  FileDiff,
  FunctionSnapshot,
  PathEdge,
  PathNode,
} from "./types.js";

export interface SideGraphNode {
  name: string;
  snapshot: FunctionSnapshot;
  /** True if this node's callers/callees were walked. */
  expanded: boolean;
  /** Exact position of the declared name (1-based line, 0-based column). */
  nameLine: number;
  nameColumn: number;
}

export interface SideGraph {
  rootKey: string | null;
  nodes: Map<string, SideGraphNode>;
  edges: Map<string, { from: string; to: string; callSites: CallSite[] }>;
}

export interface WalkLimits {
  maxDepth?: number;
  maxNodes?: number;
}

const nodeKey = (name: string, file: string): string => `${file}#${name}`;

function changed(
  files: FileDiff[],
  side: "old" | "new",
  snapshot: FunctionSnapshot,
): boolean {
  return (
    hunksForFileRange(files, side, snapshot.file, snapshot.startLine, snapshot.endLine)
      .length > 0
  );
}

/**
 * Walk the call hierarchy out from `root` in both directions (callers and
 * callees), expanding through functions the PR changed on this side. An
 * unchanged neighbor is recorded as a boundary and not walked further, so a
 * chain of changed functions is covered end to end, bracketed by its first
 * unchanged caller and callee.
 */
export async function walkCallGraph(
  backend: LanguageBackend,
  root: DeclRef,
  files: FileDiff[],
  side: "old" | "new",
  limits: WalkLimits = {},
): Promise<SideGraph> {
  const maxDepth = limits.maxDepth ?? 8;
  const maxNodes = limits.maxNodes ?? 80;
  const nodes: SideGraph["nodes"] = new Map();
  const edges: SideGraph["edges"] = new Map();

  const queue: Array<{ decl: DeclRef; depth: number }> = [{ decl: root, depth: 0 }];
  let rootKey: string | null = null;

  const addLeaf = async (key: string, entry: RelationEntry): Promise<void> => {
    if (nodes.has(key)) return;
    const full = (await backend.snapshotAt(entry.decl)) ?? entry.snapshot;
    nodes.set(key, {
      name: entry.name,
      snapshot: full,
      expanded: false,
      nameLine: entry.decl.line,
      nameColumn: entry.decl.column,
    });
  };

  while (queue.length) {
    const { decl, depth } = queue.shift()!;
    const relations = await backend.relationsAt(decl);
    if (!relations) continue;
    const myKey = nodeKey(relations.targetName, relations.target.file);
    if (rootKey === null) rootKey = myKey;
    if (nodes.get(myKey)?.expanded) continue;
    nodes.set(myKey, {
      name: relations.targetName,
      snapshot: relations.target,
      expanded: true,
      nameLine: decl.line,
      nameColumn: decl.column,
    });

    const visitNeighbor = async (
      entry: RelationEntry,
      edge: { from: string; to: string },
    ): Promise<void> => {
      const neighborKey = nodeKey(entry.name, entry.snapshot.file);
      const edgeKey = `${edge.from} ${edge.to}`;
      if (!edges.has(edgeKey)) {
        edges.set(edgeKey, { ...edge, callSites: entry.snapshot.callSites });
      }
      if (nodes.has(neighborKey)) return;
      const shouldExpand =
        changed(files, side, entry.snapshot) &&
        depth < maxDepth &&
        nodes.size < maxNodes;
      if (shouldExpand) {
        queue.push({ decl: entry.decl, depth: depth + 1 });
      } else {
        await addLeaf(neighborKey, entry);
      }
    };

    for (const caller of relations.callers) {
      await visitNeighbor(caller, {
        from: nodeKey(caller.name, caller.snapshot.file),
        to: myKey,
      });
    }
    for (const callee of relations.callees) {
      await visitNeighbor(callee, {
        from: myKey,
        to: nodeKey(callee.name, callee.snapshot.file),
      });
    }
  }

  return { rootKey, nodes, edges };
}

function mergedHunks(
  files: FileDiff[],
  before: FunctionSnapshot | null,
  after: FunctionSnapshot | null,
): DiffHunk[] {
  const seen = new Set<string>();
  const hunks: DiffHunk[] = [];
  for (const [side, snapshot] of [
    ["old", before],
    ["new", after],
  ] as const) {
    if (!snapshot) continue;
    for (const hunk of hunksForFileRange(
      files,
      side,
      snapshot.file,
      snapshot.startLine,
      snapshot.endLine,
    )) {
      if (seen.has(hunk.header)) continue;
      seen.add(hunk.header);
      hunks.push(hunk);
    }
  }
  return hunks;
}

/** Merge per-revision walks into one graph keyed by `<file>#<name>`. */
export function mergeGraphs(
  files: FileDiff[],
  before: SideGraph | null,
  after: SideGraph | null,
): { rootId: string; nodes: PathNode[]; edges: PathEdge[] } {
  const rootId = after?.rootKey ?? before?.rootKey;
  if (!rootId) throw new Error("call graph walk found no root function");

  const nodeIds = new Set([
    ...(before?.nodes.keys() ?? []),
    ...(after?.nodes.keys() ?? []),
  ]);
  const nodes: PathNode[] = [...nodeIds].map((id) => {
    const b = before?.nodes.get(id) ?? null;
    const a = after?.nodes.get(id) ?? null;
    const any = (a ?? b)!;
    const hunks = mergedHunks(files, b?.snapshot ?? null, a?.snapshot ?? null);
    return {
      id,
      name: any.name,
      file: any.snapshot.file,
      presence: b && a ? "both" : b ? "before" : "after",
      before: b?.snapshot ?? null,
      after: a?.snapshot ?? null,
      hunks,
      changedInPr: hunks.length > 0 || !(b && a),
      expanded: Boolean(b?.expanded || a?.expanded),
      nameLine: any.nameLine,
      nameColumn: any.nameColumn,
    };
  });

  const edgeIds = new Set([
    ...(before?.edges.keys() ?? []),
    ...(after?.edges.keys() ?? []),
  ]);
  const edges: PathEdge[] = [...edgeIds].map((id) => {
    const b = before?.edges.get(id) ?? null;
    const a = after?.edges.get(id) ?? null;
    const any = (a ?? b)!;
    return {
      from: any.from,
      to: any.to,
      before: b?.callSites ?? [],
      after: a?.callSites ?? [],
    };
  });

  return { rootId, nodes, edges };
}
