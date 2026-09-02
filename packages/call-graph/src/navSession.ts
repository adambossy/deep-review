/**
 * On-demand symbol navigation for one rendered page: the language services
 * stay warm behind a local server, and every question — where is this
 * symbol defined, who calls it, what does its panel look like — is answered
 * when a reader clicks, not ahead of time. Nothing is capped and nothing is
 * precomputed; the page starts small and learns as it is used.
 */

import path from "node:path";
import type { DeclRef, EnclosingDeclaration, IncomingReference, LanguageBackend } from "./backend.js";
import { Backends } from "./backends.js";
import { definitionPanelId, renderDefinitionPanel } from "./explorer.js";
import type { FileIndex } from "./html.js";
import { explorerFileIndex, type SliceExplorerInput } from "./sliceExplorer.js";
import type { DefinitionId, DefinitionTarget, ReferenceList, ReferenceSite } from "./types.js";

export { definitionPanelId } from "./explorer.js";

/** Context lines shown either side of a windowed definition. */
const WINDOW_CONTEXT = 10;
/** A windowed definition longer than this is cut off — a panel, not a file viewer. */
const WINDOW_MAX_LINES = 200;

/** What the page learns about the symbol it clicked. */
export interface DefinitionAnswer {
  id: DefinitionId;
  name: string;
  kind: string;
  /** The click was on the declaration itself: nothing to open, callers still listable. */
  self: boolean;
  external: boolean;
  /** Panel to open: a graph node's, or `def:<id>` rendered on request. */
  panelId: string;
  /** Where the declared name sits, so a declaration already on screen lights up in place. */
  decl: { file: string; line: number; column: number; endColumn: number };
}

/** Why a click resolved to nothing. */
export interface DefinitionMiss {
  why: string;
}

export type DefinitionResult = DefinitionAnswer | DefinitionMiss;

export interface PanelAnswer {
  id: string;
  name: string;
  html: string;
}

export interface NavSessionOptions {
  /** Debug builds: rendered panels explain their marks (`data-why`). */
  debug?: boolean | undefined;
}

function toRelative(root: string, fileName: string): string {
  return path.relative(root, fileName).split(path.sep).join("/");
}

export class NavSession {
  private readonly backends: Backends;
  private readonly index: FileIndex;
  private readonly debug: boolean;
  /** Head-side text by repo-relative (or absolute, external) path: embedded files plus fetched windows. */
  private readonly linesByFile = new Map<string, string[]>();
  /** Files the page embeds whole; a definition elsewhere gets a window. */
  private readonly pageFiles: Set<string>;
  /** `<file>:<nameLine>` of a graph node's declaration → the node's id. */
  private readonly nodeByDecl = new Map<string, string>();
  private readonly defs = new Map<DefinitionId, DefinitionTarget>();
  /** `<abs file>:<line>:<col>` of a declared name → its id. */
  private readonly idBySite = new Map<string, DefinitionId>();
  private readonly lookups = new Map<string, Promise<DefinitionResult>>();
  private readonly refs = new Map<DefinitionId, Promise<ReferenceList | null>>();
  private readonly panels = new Map<DefinitionId, Promise<PanelAnswer | null>>();

  constructor(
    private readonly headDir: string,
    input: SliceExplorerInput,
    options: NavSessionOptions = {},
  ) {
    this.backends = new Backends(headDir);
    this.index = explorerFileIndex(input);
    this.debug = options.debug ?? false;
    for (const file of [...input.files, ...input.slices.flatMap((s) => s.graph?.files ?? [])]) {
      if (file.side === "after" && !this.linesByFile.has(file.path)) this.linesByFile.set(file.path, file.lines);
    }
    this.pageFiles = new Set(this.linesByFile.keys());
    for (const node of input.slices.flatMap((s) => s.graph?.nodes ?? [])) {
      if (node.after) this.nodeByDecl.set(`${node.after.file}:${node.nameLine}`, node.id);
    }
  }

  /** Every language the page's files need, started now so the first click is quick. */
  warm(): void {
    for (const file of this.pageFiles) {
      const backend = this.backends.for(file);
      if (backend) void backend.fileInfo(file).catch(() => null);
    }
  }

  /** The definition of the symbol at a position the page rendered. Memoised per position. */
  definition(file: string, line: number, column: number): Promise<DefinitionResult> {
    const key = `${file}:${line}:${column}`;
    let pending = this.lookups.get(key);
    if (!pending) {
      pending = this.resolve(file, line, column);
      this.lookups.set(key, pending);
    }
    return pending;
  }

  private absolute(file: string): string {
    return path.isAbsolute(file) ? file : path.join(this.headDir, file);
  }

  private async resolve(file: string, line: number, column: number): Promise<DefinitionResult> {
    const backend = this.backends.for(file);
    if (!backend) return { why: "unsupported file" };
    const ref: DeclRef = { fileName: this.absolute(file), line, column };
    let def;
    try {
      def = await backend.definitionAt(ref);
    } catch (e: unknown) {
      return { why: `language service error (${e instanceof Error ? e.message : String(e)})` };
    }
    if (!def) return { why: "no definition" };
    const target = this.targetFor({
      fileName: def.fileName,
      name: def.name,
      kind: def.kind,
      external: def.external,
      nameLine: def.nameLine,
      nameColumn: def.nameColumn,
      nameEndColumn: def.nameEndColumn,
      startLine: def.startLine,
      endLine: def.endLine,
    });
    return {
      id: target.id,
      name: target.name,
      kind: target.kind,
      self: def.self,
      external: target.external,
      panelId: definitionPanelId(target),
      decl: {
        file: target.file,
        line: target.nameLine,
        column: target.nameColumn,
        endColumn: target.nameEndColumn,
      },
    };
  }

  /** One id per declaration site, however many uses resolve to it. */
  private targetFor(def: {
    fileName: string;
    name: string;
    kind: string;
    external: boolean;
    nameLine: number;
    nameColumn: number;
    nameEndColumn: number;
    startLine: number;
    endLine: number;
  }): DefinitionTarget {
    const site = `${def.fileName}:${def.nameLine}:${def.nameColumn}`;
    let id = this.idBySite.get(site);
    if (id) return this.defs.get(id)!;
    id = `d${this.idBySite.size + 1}`;
    this.idBySite.set(site, id);
    const file = def.external ? def.fileName : toRelative(this.headDir, def.fileName);
    const nodeId = def.external ? undefined : this.nodeByDecl.get(`${file}:${def.nameLine}`);
    const target: DefinitionTarget = {
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
      ...(nodeId ? { nodeId } : {}),
    };
    this.defs.set(id, target);
    return target;
  }

  /** The panel a reference site walks up into: its enclosing declaration's. */
  private enclosingPanel(ref: EnclosingDeclaration): string {
    const file = toRelative(this.headDir, ref.fileName);
    const nodeId = this.nodeByDecl.get(`${file}:${ref.line}`);
    if (nodeId) return nodeId;
    return definitionPanelId(
      this.targetFor({
        fileName: ref.fileName,
        name: ref.name,
        kind: ref.kind,
        external: false,
        nameLine: ref.line,
        nameColumn: ref.column,
        nameEndColumn: ref.column + ref.name.length,
        startLine: ref.startLine,
        endLine: ref.endLine,
      }),
    );
  }

  /**
   * Who calls a definition — or, for a class or constant that call hierarchy
   * does not answer for, who references it. Every site, uncapped, each with
   * the panel to walk up into. Null for an id this session never handed out.
   *
   * Call hierarchy only reports call expressions, so a function handed to
   * `functools.partial`, `asyncio.to_thread`, `map`, or a callback parameter
   * is invisible to it — and a function whose only production use is such a
   * hand-off would read as called by nothing but its tests. The reference
   * search does see those sites, so they are folded in and flagged indirect.
   */
  references(id: DefinitionId): Promise<ReferenceList | null> {
    let pending = this.refs.get(id);
    if (!pending) {
      pending = this.collectReferences(id);
      this.refs.set(id, pending);
    }
    return pending;
  }

  private async collectReferences(id: DefinitionId): Promise<ReferenceList | null> {
    const def = this.defs.get(id);
    if (!def) return null;
    const backend: LanguageBackend | null = this.backends.for(def.file);
    if (!backend) return { kind: "references", sites: [] };
    const ref: DeclRef = { fileName: this.absolute(def.file), line: def.nameLine, column: def.nameColumn };
    const [calls, uses] = await Promise.all([
      backend.incomingCallsAt(ref).catch(() => null),
      backend.referencesAt(ref).catch((): IncomingReference[] => []),
    ]);
    const site = (r: IncomingReference): ReferenceSite => ({
      file: toRelative(this.headDir, r.fileName),
      line: r.line,
      startColumn: r.startColumn,
      endColumn: r.endColumn,
      snippet: r.snippet,
      enclosingName: r.enclosing?.name ?? path.basename(r.fileName),
      ...(r.enclosing ? { panelId: this.enclosingPanel(r.enclosing) } : {}),
    });
    if (!calls) return { kind: "references", sites: uses.map(site) };
    const at = (r: IncomingReference) => `${r.fileName}:${r.line}:${r.startColumn}`;
    const called = new Set(calls.map(at));
    const sites = [
      ...calls.map(site),
      ...uses.filter((r) => !called.has(at(r))).map((r) => ({ ...site(r), indirect: true as const })),
    ].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.startColumn - b.startColumn);
    return { kind: "calls", sites };
  }

  /**
   * A definition's panel, rendered once and kept. Takes the panel id the
   * page asks by (`def:<id>`) or the bare definition id. A graph node's
   * panel is already on the page, so it is not served here.
   */
  panel(panelId: string): Promise<PanelAnswer | null> {
    const id = panelId.startsWith("def:") ? panelId.slice(4) : panelId;
    let pending = this.panels.get(id);
    if (!pending) {
      pending = this.renderPanel(id);
      this.panels.set(id, pending);
    }
    return pending;
  }

  private async renderPanel(id: DefinitionId): Promise<PanelAnswer | null> {
    const def = this.defs.get(id);
    if (!def || def.nodeId) return null;
    // A definition in a file the page embeds reads from that file (expanders
    // and all); any other gets a window — the page does not carry whole
    // files for every definition a reader might reach.
    if (def.external || !this.pageFiles.has(def.file)) {
      let lines = this.linesByFile.get(def.file);
      if (!lines) {
        const backend = this.backends.for(def.file);
        lines = (await backend?.fileInfo(def.file).catch(() => null))?.lines;
        if (!lines) return null;
        this.linesByFile.set(def.file, lines);
      }
      const from = Math.max(1, def.startLine - WINDOW_CONTEXT);
      const to = Math.min(lines.length, def.endLine + WINDOW_CONTEXT, from + WINDOW_MAX_LINES - 1);
      def.source = { startLine: from, lines: lines.slice(from - 1, to) };
    }
    const html = renderDefinitionPanel(def, this.index, { debug: this.debug });
    if (!html) return null;
    return { id: definitionPanelId(def), name: def.name, html };
  }

  dispose(): void {
    this.backends.dispose();
  }
}
