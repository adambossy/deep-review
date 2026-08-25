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
} from "./types.js";

/** Panel id of a synthesized definition panel (a graph node keeps its own id). */
export function definitionPanelId(def: DefinitionTarget): string {
  return def.nodeId ?? `def:${def.id}`;
}

export class NavIndex {
  private linksByFile = new Map<string, Map<number, SymbolLink[]>>();
  private declsByFile = new Map<string, Map<number, DefinitionTarget[]>>();
  /** file → line → [definition id, site] for every listed call site. */
  private sitesByFile = new Map<string, Map<number, Array<[DefinitionId, ReferenceSite]>>>();
  readonly definitions: ReadonlyMap<DefinitionId, DefinitionTarget>;

  constructor(readonly nav: NavigationData | undefined) {
    this.definitions = new Map(Object.entries(nav?.definitions ?? {}));
    for (const [id, list] of Object.entries(nav?.references ?? {})) {
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
    }));
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
    }));
  }

  /** Every kind of mark for a line, deduped against marks the caller already has. */
  marksFor(file: string, line: number, existing: readonly Mark[] = []): Mark[] {
    const decls = this.declMarks(file, line).filter(
      (d) => !existing.some((m) => m.cls === "self-sym" && m.start === d.start),
    );
    return [
      ...this.linkMarks(file, line, [...existing, ...decls]),
      ...decls,
      ...this.refSiteMarks(file, line),
    ];
  }
}
