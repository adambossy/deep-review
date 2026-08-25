/**
 * Render-side view of precomputed navigation data: which spans on a line are
 * tappable symbols, and which lines declare a definition the page can open.
 * Pure — no language service — so the renderers stay synchronous.
 */

import { escapeHtml as esc, type Mark } from "./highlight.js";
import type {
  DefinitionId,
  DefinitionTarget,
  NavigationData,
  ReferenceSite,
  SymbolLink,
  UnlinkedIdentifier,
} from "./types.js";

/** Panel id of a synthesized definition panel (a graph node keeps its own id). */
export function definitionPanelId(def: DefinitionTarget): string {
  return def.nodeId ?? `def:${def.id}`;
}

export interface NavIndexOptions {
  /**
   * Debug builds: every mark carries a `data-why` saying where it came from,
   * and identifiers the resolver visited but did not link get a hint too.
   */
  debug?: boolean | undefined;
}

export class NavIndex {
  private linksByFile = new Map<string, Map<number, SymbolLink[]>>();
  private declsByFile = new Map<string, Map<number, DefinitionTarget[]>>();
  /** file → line → [definition id, site] for every listed call site. */
  private sitesByFile = new Map<string, Map<number, Array<[DefinitionId, ReferenceSite]>>>();
  private unlinkedByFile = new Map<string, Map<number, UnlinkedIdentifier[]>>();
  private referenceKind = new Map<DefinitionId, "calls" | "references">();
  readonly definitions: ReadonlyMap<DefinitionId, DefinitionTarget>;
  readonly debug: boolean;

  constructor(readonly nav: NavigationData | undefined, options: NavIndexOptions = {}) {
    this.debug = options.debug ?? false;
    this.definitions = new Map(Object.entries(nav?.definitions ?? {}));
    if (this.debug) {
      for (const [file, list] of Object.entries(nav?.debug ?? {})) {
        const byLine = new Map<number, UnlinkedIdentifier[]>();
        for (const item of list) byLine.set(item.line, [...(byLine.get(item.line) ?? []), item]);
        this.unlinkedByFile.set(file, byLine);
      }
    }
    for (const [id, list] of Object.entries(nav?.references ?? {})) {
      this.referenceKind.set(id, list.kind);
      for (const site of list.sites) {
        const byLine = this.sitesByFile.get(site.file) ?? new Map<number, Array<[DefinitionId, ReferenceSite]>>();
        const at = byLine.get(site.line) ?? [];
        at.push([id, site]);
        byLine.set(site.line, at);
        this.sitesByFile.set(site.file, byLine);
      }
    }
    for (const [file, links] of Object.entries(nav?.links ?? {})) {
      const byLine = new Map<number, SymbolLink[]>();
      for (const link of links) {
        const list = byLine.get(link.line) ?? [];
        list.push(link);
        byLine.set(link.line, list);
      }
      this.linksByFile.set(file, byLine);
    }
    for (const def of this.definitions.values()) {
      if (def.external) continue;
      const byLine = this.declsByFile.get(def.file) ?? new Map<number, DefinitionTarget[]>();
      const list = byLine.get(def.nameLine) ?? [];
      list.push(def);
      byLine.set(def.nameLine, list);
      this.declsByFile.set(def.file, byLine);
    }
  }

  get empty(): boolean {
    return this.definitions.size === 0;
  }

  /** Synthesized panels needed: every openable definition that is not already a graph node. */
  panelsNeeded(): DefinitionTarget[] {
    return [...this.definitions.values()].filter((d) => d.panel && !d.nodeId);
  }

  /**
   * Tappable symbol marks on a head-side line. Spans already covered by a
   * call mark (`existing`) are left to it — it carries the same target with
   * the exact call-site range, and two marks on one span would stack
   * duplicate attributes. A definition without a panel still gets a mark
   * (its id lets an on-screen declaration light up), just no target.
   */
  linkMarks(file: string, line: number, existing: readonly Mark[] = []): Mark[] {
    const links = this.linksByFile.get(file)?.get(line) ?? [];
    const marks: Mark[] = [];
    for (const link of links) {
      const def = this.definitions.get(link.def);
      if (!def) continue;
      if (existing.some((m) => m.start < link.end && link.start < m.end)) continue;
      const target = def.panel ? `data-target="${esc(definitionPanelId(def))}" ` : "";
      marks.push({
        start: link.start,
        end: link.end,
        cls: "sym",
        attrs: `${target}data-def="${esc(def.id)}" role="button" tabindex="0"`,
        ...(this.debug ? { why: this.explainLink(def) } : {}),
      });
    }
    return marks;
  }

  /**
   * Declaration marks on a head-side line: the declared name, tagged with its
   * definition id so a click on a use elsewhere in the same pane can find it
   * and light it up in place.
   */
  declMarks(file: string, line: number): Mark[] {
    const defs = this.declsByFile.get(file)?.get(line) ?? [];
    return defs.map((def) => ({
      start: def.nameColumn,
      end: def.nameEndColumn,
      cls: "self-sym",
      attrs: `data-decl="${esc(def.id)}"`,
      ...(this.debug ? { why: `decl · ${def.name} (${def.kind}) ${def.id}` } : {}),
    }));
  }

  /** Debug builds: where a symbol link came from and whether it opens anything. */
  private explainLink(def: DefinitionTarget): string {
    const opens = def.nodeId
      ? `opens graph panel ${def.nodeId}`
      : def.panel
        ? `opens panel${def.source ? " (windowed)" : ""}`
        : `no panel: ${def.why ?? "unknown"}`;
    return `sym · ${def.name} (${def.kind}) ${def.id} in ${def.external ? "external " : ""}${
      def.external ? def.file.slice(def.file.lastIndexOf("/") + 1) : def.file
    } · ${opens}`;
  }

  /** Debug builds: hint marks over identifiers the resolver visited but did not link. */
  unlinkedMarks(file: string, line: number, existing: readonly Mark[] = []): Mark[] {
    const items = this.unlinkedByFile.get(file)?.get(line) ?? [];
    return items
      .filter((u) => !existing.some((m) => m.start < u.end && u.start < m.end))
      .map((u) => ({ start: u.start, end: u.end, cls: "id-dbg", why: u.why }));
  }

  /**
   * Call-site marks on a head-side line: where a listed caller invokes a
   * definition, tagged with that definition's id so walking up from the
   * callers menu can light the site up in the caller's panel.
   */
  refSiteMarks(file: string, line: number): Mark[] {
    const sites = this.sitesByFile.get(file)?.get(line) ?? [];
    return sites.map(([id, site]) => ({
      start: site.startColumn,
      end: site.endColumn,
      cls: "ref-site",
      attrs: `data-ref-of="${esc(id)}"`,
      ...(this.debug ? { why: `ref-site · ${this.referenceKind.get(id) === "calls" ? "call" : "reference"} of ${id}` } : {}),
    }));
  }

  /** Every kind of mark for a line, deduped against marks the caller already has. */
  marksFor(file: string, line: number, existing: readonly Mark[] = []): Mark[] {
    const decls = this.declMarks(file, line).filter(
      (d) => !existing.some((m) => m.cls === "self-sym" && m.start === d.start),
    );
    const links = this.linkMarks(file, line, [...existing, ...decls]);
    const marks = [...links, ...decls, ...this.refSiteMarks(file, line)];
    return this.debug ? [...marks, ...this.unlinkedMarks(file, line, [...existing, ...marks])] : marks;
  }
}
