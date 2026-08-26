# On-demand LSP navigation: one code pane, then a local server

## Context

Before this work `pr-review` precomputed every navigation fact up front
(`resolveNavigation`, `packages/call-graph/src/navigation.ts`): ~20k
`textDocument/definition` calls, up to 1000 pre-rendered definition panels in
`#shared-defs`, callers capped at 10 per symbol, ~90s of pyright time, and a
12–14 MB HTML file. The user wants to replace that with a tiny **local Node
server** (the repo is TypeScript; the LSP client `lsp.ts` / `lspBackend.ts` /
`tsBackend.ts` already lives in Node) that keeps `Backends(headDir)` warm and
answers definition / references / panel requests when a symbol is clicked.
Caps disappear, generation gets fast, and the page shrinks.

Before that migration, the user wanted the **code pane unified**: function,
definition, and slice panels all rendering source the same way, manually
verified against the existing example reports before Stage 2 began.

Decisions already made:
- Node server reusing existing backends (not Python).
- Serve-only: `pr-review` starts the server and opens `http://127.0.0.1:<port>/`;
  the precompute path (`resolveNavigation`, `--no-nav`, `--nav-budget`) goes away.
- Definition panels are server-rendered HTML (`renderDefinitionPanel`), cached
  client-side in `#shared-defs`, cloned exactly as today.
- Unify the pane first, with a user feedback loop, then do the server.

---

## Stage 1 — One code pane ✅ shipped and reviewed

Landed in `5a112b9` (refactor: one pane + debug overlay) and adjusted during
the user's manual review in `d7785b8`, `de54ebe`, `7468b8c`, `587db8a`. The
user signed off; Stage 2 may start.

### What shipped (as designed)

- **`packages/call-graph/src/codePane.ts`** — `renderCodePane(CodePaneInput)`
  is the one way a panel shows code: `<div class="code-pane"><div
  class="scope-bar" data-key>…</div><pre class="source" data-w>…</pre></div>`.
  Header = dimmed dir + bold basename, `.scope-sym`, and a `+N −M` stat.
  `renderPanel`, `renderDefinitionPanel`, `renderSlicePanel`, and the legacy
  single-target card in `html.ts` all go through it; `.file-block`,
  `renderFileBlock`, `fileHead`, `contextRow` are gone.
- **`diffView.fragmentDiffRows(lines, fragments, context)`** builds the slice
  panel's rows as pure data (context merge, deletion-only fragments, no-entry
  fallback with static gaps).
- **`--debug-marks`** on `pr-review`, threaded as `debugMarks` → renderers'
  `debug` flag. Every mark carries `data-why` provenance; nothing debug-related
  is emitted without the flag (asserted in `sliceExplorer.test.ts`).
- **`packages/review/scripts/rerender.sh`** re-renders saved slice reports
  into `pane-preview/` with `--debug-marks --no-open`.

### How the review changed it (differences from the original design)

- `CodePaneInput` has no `stats` option — the `+N −M` stat shows on every pane
  whenever the rows change anything. It has a `debug` flag instead.
- `fragmentRows` survived in `diffView.ts` as the per-fragment helper;
  `fragmentDiffRows` takes `context` positionally (`FRAGMENT_CONTEXT` default).
- The "not visited by the resolver" hint over unexplained identifiers is
  produced by `renderDiffRows` (`unexplainedMarks`, `diffView.ts`), not by
  `NavIndex` — the pane, not the resolver, knows which identifiers it drew.
- **Debug labels show on hover only** (`d7785b8`): with Shift held, only the
  hovered span shows its `data-why`, in 0.72rem type; labelling every span at
  once buried dense lines. Long labels wrap instead of clipping at the pane
  edge (`de54ebe`). The legend chip still lists class → colour → meaning.
- **`panelFor` falls back to every track's `.panel-defs`** (`7468b8c`): a
  symbol can resolve to a call-graph node walked only by *another* slice; its
  panel is in the DOM (hidden) but neither in this track's defs nor in
  `#shared-defs`. Stage 2's async `panelFor` must keep this lookup order:
  own track → `#shared-defs` → any `.panel-defs` → server.
- **Scope-bar pinned flush** (`587db8a`): the bar breaks out of `.panel`'s
  padding with a negative margin and `top: -0.7rem` so it sticks to the
  panel's true edge; square top corners. Pane CSS only — Stage 2 leaves it.
- **`symbolMarks` only marks called occurrences** (`587db8a`): a graph
  symbol's text match must be followed by `(`, so a local variable that
  merely shares a node's name (`now`, `active`) no longer lights up. Moot
  once Stage 2 deletes `symbolMarks` — the language service answers those
  clicks exactly.

---

## Stage 2 — Local server, on-demand LSP

### Findings that revise the original Stage 2 design

1. **Clicking a declaration must still answer.** Both backends' `definitionAt`
   return `null` when the position *is* the declaration. Today ⌘-click on a
   newly declared function in the slice panel works because precomputed
   `declMarks` put `.self-sym[data-decl]` there; with nothing precomputed the
   server would say "no definition" and the callers menu would go dark for the
   most common question a reviewer asks ("who calls this new function?").
   → `definitionAt` returns the declaration itself with `self: true`
   (`DefinitionLocation.self`), in `callHierarchy.definitionAt` and
   `LspBackend.definitionAt`. A plain click on a self-declaration opens
   nothing (it is already on screen); ⌘-click lists its callers.
2. **Before-side panels have no head coordinates.** The server resolves
   against `headDir`; a before-only function's panel (removed code) cannot be
   asked about. The graph-edge `.csite` marks in `renderPanel` (exact columns
   from the language service, precomputed for free) are the only way to walk
   down from such a panel. → **Keep graph-edge `.csite` marks** in function
   panels; delete only the text-heuristic `symbolMarks` in the slice panel.
   The client still has one handler: a span with `data-target` opens directly,
   anything else asks the server.
3. **A reload must not kill the server.** `beforeunload` fires on reload as
   well as on close. → The shutdown beacon starts a 3 s grace timer that any
   incoming request cancels.
4. **`rerender.sh` needs a non-serving mode.** → `--no-serve` writes `--out`
   and exits (static page, navigation inert); the script passes it.
5. `NavIndex` has nothing left to do: `renderDefinitionPanel` writes its own
   `.self-sym[data-decl]` mark, and every other mark it produced came from
   precomputed data. → Delete `navLinks.ts` whole; `definitionPanelId` moves
   to `navSession.ts`.

### `NavSession` — `packages/call-graph/src/navSession.ts` (replaces `navigation.ts`)

Holds `Backends(headDir)`, the page's `FileIndex`, `linesByFile` (embedded
files, plus windows fetched via `fileInfo`), and `nodeByDecl`
(`<file>:<nameLine>` → graph node id, from every slice's graph):

```ts
class NavSession {
  constructor(headDir, input: SliceExplorerInput, { debug })
  async definition(file, line, column): Promise<DefinitionAnswer>
  async references(id): Promise<ReferenceList | null>
  async panel(id): Promise<{ id, name, html } | null>
  dispose()
}
```

- `definition`: `identifiersOf`-independent — the client sends the column of
  the span it rendered. `backend.definitionAt`; the def-site key
  `<abs file>:<nameLine>:<nameColumn>` → stable id `d1, d2, …` (memoised per
  `<file>:<line>:<col>` lookup too). A definition whose declaration is a graph
  node gets `nodeId`, so its `panelId` is the node's — the client finds the
  existing per-slice function panel first. Answer:
  `{ id, name, kind, self, external, panelId, decl: {file, line, column,
  endColumn} } | { why }` where `why` is one of `no definition`, `language
  service error (…)`, `unsupported file`, `file not on the page`.
- `references(id)`: `incomingCallsAt ?? referencesAt`, **no cap**; each site
  gets `panelId` for its enclosing declaration (graph node id or a definition
  id allocated on the spot — the panel renders lazily on `/panel`). Cached
  per id.
- `panel(id)`: `renderDefinitionPanel` for a non-node definition. Source: the
  embedded file when the page has it, else a window (`WINDOW_CONTEXT=10`,
  `WINDOW_MAX_LINES=200`) read through `fileInfo`. Cached (promise) per id;
  `null` when the source is unavailable.

`DefinitionTarget` loses `panel`/`why` (every definition can have a panel,
rendered on demand); `NavigationData`, `SymbolLink`, `UnlinkedIdentifier`
are deleted; `ReferenceList` is `{ kind, sites }`.

### Server — `packages/review/src/serve.ts` (new)

`node:http` on `127.0.0.1`, random port unless `--port`. All routes
`Cache-Control: no-store`:
- `GET /` → the explorer HTML.
- `GET /definition?file&line&col` → `DefinitionAnswer` JSON.
- `GET /references?id` → `ReferenceList` JSON (404 for an unknown id).
- `GET /panel?id` → `{ id, name, html }` JSON (404 when unavailable).
- `POST /shutdown` → exits after a 3 s grace period unless another request
  arrives (a reload). Also exits on SIGINT and when stdin closes.
  `NavSession.dispose()` (→ `Backends.dispose()`) on the way out.

The checkout under `os.tmpdir()/deep-review/<owner>-<repo>-pr<n>` stays put;
the server just reads it. On start, log the URL and "press Ctrl-C to stop",
and warm each language's backend with one `fileInfo` so the first click is
quick.

### CLI — `packages/review/src/cli.ts`
- Drop `--no-nav`, `--nav-budget`. Add `--port <n>`, `--no-serve`. Keep
  `--out` (static copy for archiving; written whenever given), `--no-open`,
  `--debug-marks`.
- After `renderSliceExplorerHtml`: write `--out` if given; unless
  `--no-serve`, start the server, print the URL, `open` it (unless
  `--no-open`), and keep running.
- `build.ts`: remove the `resolveNavigation` call and the `navigation` /
  `navBudget` options; `SliceExplorerInput.nav` goes away.

### Page — one click mechanism
- `renderDiffRows` gains `identifiers: true` (set through `CodePaneInput`
  for every explorer pane): each identifier not already covered by a mark
  gets a bare `<span class="id">` — the debug-only `unexplainedMarks`
  generalised. The pane carries `data-file` (repo-relative, or absolute for an
  external window) and `data-side`, so a click knows where it is even in a
  pane with no embedded `entry`.
- Click handler (`EXPLORER_NAV_JS`): a span with `data-target` (graph-edge
  `.csite`, `.caller-row`, or an `.id` that was resolved earlier) opens
  directly. Otherwise, for an `.id` in an after-side pane: line from the row's
  `.lineno`, column from a DOM Range spanning the row's content start to the
  span, `fetch('/definition')`. On an answer: stamp the span with `data-def`
  / `data-target` and class `sym` (the page learns as it is used); if `decl`
  is a visible line of the same pane, `linkInPlace` on the span at that
  column; else `panelFor(panelId)`. `self` answers open nothing.
- `panelFor(id)` is async: own track's `.panel-defs` → `#shared-defs` → any
  `.panel-defs` (the `7468b8c` fallback) → `fetch('/panel')`, insert into
  `#shared-defs`, record the name in `DEFNAMES`, clone. `walkDown` / `walkUp`
  / `__restore` await it; history restore replays through the same path.
- ⌘-click → `fetch('/references?id')` (resolving first if the span has no
  `data-def`); `openRefMenu` shows "resolving…" then rows built from the
  response — no "+N more". A row walks up to `site.panelId`; the site is then
  found in the caller's panel by `line` + `startColumn` (the `.id` span at
  that column) and lit as `.sym-link`, scrolled into view. `window.REFS`,
  `#ref-data`, `#def-names` blobs go away.
- `beforeunload` → `navigator.sendBeacon('/shutdown')`.
- Without a server (static `--out` page) every fetch fails quietly: the page
  still reads, graph-edge marks still walk.

### Debug overlay under Stage 2
Precomputed marks keep their `data-why` (`csite · call-graph edge …`, `decl ·
…`). An `.id` span gets `data-why` client-side after it is clicked, from the
server's answer (`sym · <name> (<kind>) <id> in <file> · opens panel …`, or
the `why` of a miss); the `.id-dbg` / "not visited by the resolver" hint goes
away since nothing is visited ahead of time. Legend updated accordingly.
Still nothing debug-related without the flag.

### Tests (Stage 2)
- `callHierarchy.test.ts` / `pyGraph.test.ts`: a declaration resolves to
  itself with `self: true`.
- `navSession.test.ts` (fixture from `navigation.test.ts`): ids stable across
  calls and shared between a use and its import; graph-node definitions carry
  `nodeId`; a self-declaration answers `self`; references are uncapped with a
  `panelId` per site; `panel()` windows a file not on the page and caches.
- `serve.test.ts`: real server on a temp TS project — `/`, `/definition`,
  `/references`, `/panel`, 404s, `no-store`, `/shutdown` grace cancelled by a
  request.
- `sliceExplorer.test.ts` / `explorer.test.ts` / `diffView.test.ts`: `.id`
  spans and `data-file` present; no `symbolMarks` csites in the slice panel;
  no `ref-data` / `def-names` blobs; fetch-based JS strings present; graph
  edge `.csite` marks still present in function panels; debug output still
  gated.
- `build.test.ts`: no `nav` on the input.

---

## Verification

Stage 1 (done): re-rendered the saved reports, compared panels visually,
`pnpm test` green, user signed off.

Stage 2: `pnpm --filter @deep-review/review cli --slices <slices.json>` →
browser opens `http://127.0.0.1:<port>/`; click a symbol in the slice panel
(panel slides in), click one inside that panel (second hop), ⌘-click a
function name — including a newly declared one — (callers menu, no "+N
more"), click a row (walks up, site highlighted), reload (server survives;
history restores through async `panelFor`), close the tab or Ctrl-C (server
and pyright exit). Generation time and page size drop noticeably versus the
precomputed report (note both numbers).
