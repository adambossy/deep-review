/**
 * Build-time symbol resolution: ask the language services where every
 * identifier the report will show is defined, and embed the answers so the
 * static page can open any symbol without a server.
 */

import path from "node:path";
import type { DeclRef, IncomingReference as IncomingReferenceOf, LanguageBackend } from "./backend.js";
import { Backends } from "./backends.js";
import { panelRange } from "./explorer.js";
import { identifiersOf, languageOf } from "./highlight.js";
import { scopeChainFor } from "./html.js";
import { definitionPanelId as definitionPanelIdOf } from "./navLinks.js";
import { fileBlockRanges, type SliceExplorerInput } from "./sliceExplorer.js";
import type {
  DefinitionId,
  DefinitionTarget,
  NavigationData,
  ReferenceList,
  ReferenceSite,
  SymbolLink,
  SymbolRange,
} from "./types.js";

export interface NavigationOptions {
  onProgress?: (message: string) => void;
  /** Stop asking the language service after this many identifier lookups. */
  maxLookups?: number;
  /** Synthesize at most this many definition panels; later links are dropped. */
  maxPanels?: number;
  /** Call sites kept per definition for the callers menu. */
  maxReferences?: number;
}

/** Context lines shown either side of a windowed definition. */
const WINDOW_CONTEXT = 10;
/** A windowed definition longer than this is cut off — a panel, not a file viewer. */
const WINDOW_MAX_LINES = 200;
/** Concurrent in-flight requests to an LSP server; one round trip per batch. */
const LSP_BATCH = 32;

/**
 * Head-side lines the renderers will show, by file, each tagged with a
 * priority: 0 for a fragment's own lines, 1 for the context around them, 2
 * for call-graph panel bodies. Mirrors the renderers exactly (same range
 * helpers), so no lookup is wasted on a line that never appears.
 */
export function visibleLines(input: SliceExplorerInput): Map<string, Map<number, number>> {
  const wanted = new Map<string, Map<number, number>>();
  const lineCounts = new Map<string, number>();
  for (const file of [...input.files, ...input.slices.flatMap((s) => s.graph?.files ?? [])]) {
    if (file.side === "after" && !lineCounts.has(file.path)) lineCounts.set(file.path, file.lines.length);
  }
  const want = (file: string, line: number, priority: number): void => {
    const count = lineCounts.get(file);
    if (count === undefined || line < 1 || line > count) return;
    const lines = wanted.get(file) ?? new Map<number, number>();
    lines.set(line, Math.min(priority, lines.get(line) ?? priority));
    wanted.set(file, lines);
  };

  for (const slice of input.slices) {
    const byFile = new Map<string, typeof slice.fragments>();
    for (const fragment of slice.fragments) {
      byFile.set(fragment.file, [...(byFile.get(fragment.file) ?? []), fragment]);
    }
    for (const [file, fragments] of byFile) {
      const count = lineCounts.get(file);
      if (count === undefined) continue;
      const own = new Set<number>();
      for (const fragment of fragments) {
        for (const n of fragment.newLineNumbers) if (n !== null) own.add(n);
      }
      for (const [from, to] of fileBlockRanges(fragments, count)) {
        for (let n = from; n <= to; n++) want(file, n, own.has(n) ? 0 : 1);
      }
    }
    for (const node of slice.graph?.nodes ?? []) {
      if (!node.after) continue;
      const count = lineCounts.get(node.after.file);
      if (count === undefined) continue;
      const [from, to] = panelRange(node.after, count);
      for (let n = from; n <= to; n++) want(node.after.file, n, 2);
    }
  }
  return wanted;
}

function toRelative(root: string, fileName: string): string {
  return path.relative(root, fileName).split(path.sep).join("/");
}

/**
 * Kinds whose definition is a local name — the least worth a panel of their
 * own. Pyright reports every non-class/function binding as "variable"; the
 * TypeScript service says "const" for module-level and local consts alike,
 * so those stay eligible.
 */
const LOCAL_KINDS = new Set(["variable", "parameter", "local var", "let", "var"]);
/** Symbol kinds whose body makes the names declared inside it local. */
const CALLABLE_SCOPES = new Set(["function", "method", "constructor", "accessor"]);

interface Lookup {
  file: string;
  line: number;
  start: number;
  end: number;
  priority: number;
}

/**
 * Resolve every visible identifier to its definition. Lookups run in
 * priority order under a budget, so a huge PR still gets its changed lines
 * linked even if some context goes unresolved.
 */
export async function resolveNavigation(
  headDir: string,
  input: SliceExplorerInput,
  options: NavigationOptions = {},
): Promise<NavigationData> {
  const log = options.onProgress ?? (() => {});
  // Defaults sized from a ~1k-line Python PR: ~20k lookups in ~90s with
  // pyright, ~4k distinct definitions, ~370 named ones plus their callers
  // wanting panels. Each synthesized panel is ~7 KB of pre-rendered HTML, so
  // the panel cap is what bounds the page.
  const maxLookups = options.maxLookups ?? 20_000;
  const maxPanels = options.maxPanels ?? 1000;
  const maxReferences = options.maxReferences ?? 10;
  const backends = new Backends(headDir);

  const linesByFile = new Map<string, string[]>();
  for (const file of [...input.files, ...input.slices.flatMap((s) => s.graph?.files ?? [])]) {
    if (file.side === "after" && !linesByFile.has(file.path)) linesByFile.set(file.path, file.lines);
  }
  // Files the page embeds whole; a definition elsewhere gets a window.
  const pageFiles = new Set(linesByFile.keys());
  // A graph node's declaration already has a panel: link to it rather than
  // synthesizing a duplicate.
  const nodeByDecl = new Map<string, string>();
  for (const node of input.slices.flatMap((s) => s.graph?.nodes ?? [])) {
    if (node.after) nodeByDecl.set(`${node.after.file}:${node.nameLine}`, node.id);
  }

  const links: Record<string, SymbolLink[]> = {};
  const definitions: Record<DefinitionId, DefinitionTarget> = {};
  /** `<file>:<line>:<col>` of a declared name → its page-local id. */
  const idBySite = new Map<string, DefinitionId>();
  const memo = new Map<string, DefinitionId | null>();
  let lookups = 0;
  let unresolvedForBudget = 0;

  const resolveOne = async (
    backend: LanguageBackend,
    lookup: Lookup,
  ): Promise<void> => {
    const key = `${lookup.file}:${lookup.line}:${lookup.start}`;
    let id = memo.get(key);
    if (id === undefined) {
      if (lookups >= maxLookups) {
        unresolvedForBudget++;
        return;
      }
      lookups++;
      const ref: DeclRef = {
        fileName: path.join(headDir, lookup.file),
        line: lookup.line,
        column: lookup.start,
      };
      const def = await backend.definitionAt(ref).catch(() => null);
      if (def) {
        const site = `${def.fileName}:${def.nameLine}:${def.nameColumn}`;
        id = idBySite.get(site);
        if (!id) {
          id = `d${idBySite.size + 1}`;
          idBySite.set(site, id);
          const file = def.external ? def.fileName : toRelative(headDir, def.fileName);
          const nodeId = def.external ? undefined : nodeByDecl.get(`${file}:${def.nameLine}`);
          definitions[id] = {
            id,
            name: def.name,
            kind: def.kind,
            file,
            external: def.external,
            nameLine: def.nameLine,
            nameColumn: def.nameColumn,
            nameEndColumn: def.nameEndColumn,
            startLine: def.startLine,
            endLine: def.endLine,
            panel: Boolean(nodeId),
            ...(nodeId ? { nodeId } : {}),
          };
        }
      } else {
        id = null;
      }
      memo.set(key, id);
    }
    if (id) (links[lookup.file] ??= []).push({ line: lookup.line, start: lookup.start, end: lookup.end, def: id });
  };

  const resolveLines = async (wanted: Map<string, Map<number, number>>): Promise<void> => {
    const queue: Array<{ backend: LanguageBackend; lookup: Lookup }> = [];
    for (const [file, lines] of wanted) {
      const backend = backends.for(file);
      const text = linesByFile.get(file);
      if (!backend || !text) continue;
      const ids = identifiersOf(text, languageOf(file));
      for (const [line, priority] of lines) {
        for (const tok of ids[line - 1] ?? []) {
          queue.push({ backend, lookup: { file, line, start: tok.start, end: tok.end, priority } });
        }
      }
    }
    queue.sort((a, b) => a.lookup.priority - b.lookup.priority);
    log(`navigation: resolving ${queue.length} identifiers across ${wanted.size} files…`);

    let i = 0;
    while (i < queue.length) {
      const { backend } = queue[i]!;
      const batch = backends.batched(backend) ? LSP_BATCH : 1;
      const slice = queue.slice(i, i + batch).filter((q) => q.backend === backend);
      await Promise.all(slice.map((q) => resolveOne(backend, q.lookup)));
      i += slice.length;
    }
  };

  // Give a synthesized panel its source and mark it openable. A definition
  // in a file the page already embeds reads from that file (expanders and
  // all); any other gets a window — embedding whole files for every
  // definition reached would triple the page.
  let panels = 0;
  /** Head lines of every synthesized panel, to link their bodies in turn. */
  const panelLines = new Map<string, Map<number, number>>();
  const attachPanel = async (def: DefinitionTarget): Promise<boolean> => {
    if (def.panel) return true;
    if (panels >= maxPanels) return false;
    panels++; // reserve before awaiting so concurrent callers cannot overshoot
    let range: [number, number];
    if (!def.external && pageFiles.has(def.file)) {
      range = panelRange(def, linesByFile.get(def.file)!.length);
    } else {
      let lines = linesByFile.get(def.file);
      if (!lines) {
        const backend = backends.for(def.file);
        lines = (await backend?.fileInfo(def.file).catch(() => null))?.lines;
        if (!lines) {
          panels--;
          return false;
        }
        linesByFile.set(def.file, lines);
      }
      const from = Math.max(1, def.startLine - WINDOW_CONTEXT);
      const to = Math.min(lines.length, def.endLine + WINDOW_CONTEXT, from + WINDOW_MAX_LINES - 1);
      def.source = { startLine: from, lines: lines.slice(from - 1, to) };
      range = [from, to];
    }
    def.panel = true;
    if (!def.external) {
      const lines = panelLines.get(def.file) ?? new Map<number, number>();
      for (let n = range[0]; n <= range[1]; n++) lines.set(n, 3);
      panelLines.set(def.file, lines);
    }
    return true;
  };
  // A "variable" is local only when it is declared inside a function; a
  // module-level `settings = Settings()` has the same kind and deserves a
  // panel and a callers list like any constant. Decided from the file's
  // symbol tree, fetched once per file.
  const symbolsByFile = new Map<string, Promise<SymbolRange[]>>();
  const symbolsOf = (file: string): Promise<SymbolRange[]> => {
    let pending = symbolsByFile.get(file);
    if (!pending) {
      pending = backends.for(file)?.fileInfo(file).then((i) => i?.symbols ?? []).catch(() => []) ?? Promise.resolve([]);
      symbolsByFile.set(file, pending);
    }
    return pending;
  };
  const isLocal = async (d: DefinitionTarget): Promise<boolean> => {
    if (!LOCAL_KINDS.has(d.kind)) return false;
    if (d.kind === "parameter") return true;
    if (d.external) return false;
    return scopeChainFor(await symbolsOf(d.file), d.nameLine).some((s) => CALLABLE_SCOPES.has(s.kind));
  };

  // Who calls each repo-internal, named definition — for the callers
  // menu. Call hierarchy for callables; plain references for classes and
  // constants, which call hierarchy does not answer for. Each site's
  // enclosing declaration gets a panel too (budget permitting), so a row can
  // walk up into it.
  const references: Record<DefinitionId, ReferenceList> = {};
  const enclosingPanel = async (ref: NonNullable<IncomingReferenceOf["enclosing"]>): Promise<string | undefined> => {
      const file = toRelative(headDir, ref.fileName);
      const nodeId = nodeByDecl.get(`${file}:${ref.line}`);
      if (nodeId) return nodeId;
      const site = `${ref.fileName}:${ref.line}:${ref.column}`;
      let id = idBySite.get(site);
      if (!id) {
        id = `d${idBySite.size + 1}`;
        idBySite.set(site, id);
        definitions[id] = {
          id,
          name: ref.name,
          kind: ref.kind,
          file,
          external: false,
          nameLine: ref.line,
          nameColumn: ref.column,
          nameEndColumn: ref.column + ref.name.length,
          startLine: ref.startLine,
          endLine: ref.endLine,
          panel: false,
        };
      }
      const def = definitions[id]!;
      return (await attachPanel(def)) ? definitionPanelIdOf(def) : undefined;
    };
    const collectReferences = async (def: DefinitionTarget): Promise<void> => {
      const backend = backends.for(def.file);
      if (!backend) return;
      const ref: DeclRef = { fileName: path.join(headDir, def.file), line: def.nameLine, column: def.nameColumn };
      const calls = await backend.incomingCallsAt(ref).catch(() => null);
      const found = calls ?? (await backend.referencesAt(ref).catch(() => []));
      if (!found.length) return;
      const sites: ReferenceSite[] = [];
      for (const r of found.slice(0, maxReferences)) {
        const panelId = r.enclosing ? await enclosingPanel(r.enclosing) : undefined;
        sites.push({
          file: toRelative(headDir, r.fileName),
          line: r.line,
          startColumn: r.startColumn,
          endColumn: r.endColumn,
          snippet: r.snippet,
          enclosingName: r.enclosing?.name ?? path.basename(r.fileName),
          ...(panelId ? { panelId } : {}),
        });
      }
      references[def.id] = { kind: calls ? "calls" : "references", total: found.length, sites };
    };

  try {
    await resolveLines(visibleLines(input));

    // Panel budget, in order of worth: named declarations the diff mentions,
    // then the functions that call them (so every menu row can walk up),
    // then locals — a loop variable's declaration is usually on screen anyway.
    const firstPass = Object.values(definitions).filter((d) => !d.nodeId);
    const locality = new Map<DefinitionId, boolean>();
    for (const def of firstPass) locality.set(def.id, await isLocal(def));
    for (const def of firstPass) if (!locality.get(def.id)) await attachPanel(def);

    const candidates = Object.values(definitions).filter(
      (d) => d.panel && !d.external && !locality.get(d.id),
    );
    log(`navigation: collecting callers of ${candidates.length} definitions…`);
    for (let i = 0; i < candidates.length; ) {
      const backend = backends.for(candidates[i]!.file);
      const batch = backend && backends.batched(backend) ? LSP_BATCH : 1;
      const group = candidates.slice(i, i + batch).filter((c) => backends.for(c.file) === backend);
      await Promise.all(group.map(collectReferences));
      i += group.length;
    }

    for (const def of firstPass) if (locality.get(def.id)) await attachPanel(def);

    // Second pass: link the synthesized panels' own bodies, one level deep.
    // Named declarations found here get panels too (within the budget);
    // locals do not — their declaration is almost always inside the very
    // window that mentions them, where the in-place highlight covers it.
    // Nothing found here is resolved in turn: that would be the whole codebase.
    const before = new Set(Object.keys(definitions));
    await resolveLines(new Map(panelLines));
    for (const def of Object.values(definitions)) {
      if (!before.has(def.id) && !def.nodeId && !(await isLocal(def))) await attachPanel(def);
    }

    const unopenable = Object.values(definitions).filter((d) => !d.panel).length;
    if (unopenable) {
      log(`navigation: ${unopenable} definitions have no panel (--nav-panels ${maxPanels}); their on-screen declarations still highlight.`);
    }

    const linked = Object.values(links).reduce((n, l) => n + l.length, 0);
    log(
      `navigation: ${linked} symbol links → ${Object.keys(definitions).length} definitions, ${
        Object.keys(references).length
      } with callers (${lookups} lookups${
        unresolvedForBudget ? `, ${unresolvedForBudget} skipped for --nav-budget` : ""
      }).`,
    );
    return { links, definitions, references };
  } finally {
    backends.dispose();
  }
}
