# On-demand LSP navigation: one code pane, then a local server

## Context

Today `pr-review` precomputes every navigation fact up front (`resolveNavigation`,
`packages/call-graph/src/navigation.ts`): ~20k `textDocument/definition` calls,
up to 1000 pre-rendered definition panels in `#shared-defs`, callers capped at
10 per symbol, ~90s of pyright time, and a 12–14 MB HTML file. The user wants
to replace that with a tiny **local Node server** (the repo is TypeScript; the
LSP client `lsp.ts` / `lspBackend.ts` / `tsBackend.ts` already lives in Node)
that keeps `Backends(headDir)` warm and answers definition / references /
panel requests when a symbol is clicked. Caps disappear, generation gets fast,
and the page shrinks.

Before that migration, the user wants the **code pane unified**: today
function/definition panels render source via `panelRows → renderDiffBlock →
codePane` (`explorer.ts:93`, `:209`), while the slice panel hand-builds its own
`<div class="file-block">` in `renderFileBlock` (`sliceExplorer.ts:233`) with a
third symbol-marking mechanism (`symbolMarks`). Every panel should render its
pane the same way. That component must be **manually verified by the user
against the existing example reports before Stage 2 begins.**

Decisions already made:
- Node server reusing existing backends (not Python).
- Serve-only: `pr-review` starts the server and opens `http://127.0.0.1:<port>/`;
  the precompute path (`resolveNavigation`, `--no-nav`, `--nav-budget`) goes away.
- Definition panels are server-rendered HTML (`renderDefinitionPanel`), cached
  client-side in `#shared-defs`, cloned exactly as today.
- Unify the pane now, with a user feedback loop, then do the server.

---

## Stage 1 — One code pane (user-verified before Stage 2)

### Design

Introduce a single pane component and make all three panel kinds use it.

**`packages/call-graph/src/codePane.ts`** (new; move `codePane` out of `html.ts`)

```ts
export interface CodePaneInput {
  file: string;                 // repo-relative (or basename for external)
  entry: FileEntry | undefined; // embedded head file, enables expanders + scope-bar
  rows: DiffRow[];              // from fileDiffRows / fragmentDiffRows / segmentRows
  lang: Language;
  decorations?: Decorations;    // csite / self-sym / sym marks
  marksFor?: (text, headLine) => Mark[];
  focus?: LineSpan;
  stats?: boolean;              // show +N −M in the header (slice panel wants it)
}
export function renderCodePane(input: CodePaneInput): string
```

Output = the one markup: `<div class="code-pane"><div class="scope-bar" data-key>…</div><pre class="source" data-w>…</pre></div>`.
The header adopts the slice panel's richer `fileHead` styling (dimmed dir +
bold basename, `.scope-sym`, optional `+N −M` stat) since it is the more
finished design — merge `.file-head` CSS (`sliceExplorer.ts:448-460`) into the
`.scope-bar` CSS (`html.ts:463-474`), drop the `.file-head` class. `SCOPE_JS`
(`html.ts:565`) already keys on `.scope-bar[data-key]`, so pinned scope keeps
working everywhere.

**`packages/call-graph/src/diffView.ts`** — add `fragmentDiffRows(lines, fragments, {context})`:
the row-building half of `renderFileBlock` (`sliceExplorer.ts:255-295`) as
pure data: walks `fileBlockRanges`, emits `gap` rows for hidden stretches,
`ctx` rows for context, and the fragment's own rows via the existing
`diffFragmentRows(fragment.lines, fragment.newLineNumbers)`. For a file with no
`entry`, emit fragment rows separated by non-expandable gaps (today's
`staticGapRow` branch — `gap` rows render static when `entry` is undefined,
which `renderDiffRows` already handles).

**Callers to convert**
- `renderPanel` (`explorer.ts:189`) and `renderDefinitionPanel` (`explorer.ts:236`):
  replace `codePane(file, entry, firstHeadLine(rows), renderDiffBlock(rows, …))`
  with one `renderCodePane({...})`.
- `renderSlicePanel` (`sliceExplorer.ts:345`): replace `renderFileBlock` with
  `renderCodePane({ file, entry, rows: fragmentDiffRows(...), marksFor, stats: true })`.
  Keep `symbolMarks` + `nav.marksFor` behaviour by passing them through
  `marksFor` (this stage changes layout only — marks are Stage 2's job).
  Delete `renderFileBlock`, `fragmentRows`, `fileHead`, `contextRow`.
- `html.ts:898` (legacy single-target card): switch to `renderCodePane` so
  `codePane` can be deleted; `renderHunksBlock` (`html.ts:209`) becomes a
  `fileDiffRows`/`hunkRows` + `renderCodePane` call.

Context widths stay as they are (`PANEL_CONTEXT=10`, `FRAGMENT_CONTEXT=5`,
`HUNK_CONTEXT=3`) — passed in, not hardcoded in the pane.

### Feedback loop (the gate)

Add a small dev script `packages/review/scripts/rerender.sh` (or a `pnpm`
script) that re-renders the saved slice reports without an LLM run:

```
pnpm --filter @deep-review/review cli --slices <slices.json> --debug-marks --no-open --out <out.html>
```
(`--slices` skips the agent. Nav is left on so the debug overlay below can
explain every mark; use `--nav-budget` to trade fidelity for iteration speed. `loadRenderEntry`
re-fetches the PR and reuses the cached checkout under `os.tmpdir()/deep-review/`,
so GitHub access is needed once per PR.)

Inputs: the saved reports beside the checked-in examples —
`packages/review/slices-spara-app-pr{10161,10324,10365}.json` in this worktree,
plus the 12 more in `~/code/deep-review/packages/review/slices-*.json`. Render
at least 10161, 10324, 10365 and two or three from the main checkout that have
deletion-only fragments / non-embedded files, into
`packages/review/pane-preview/`. Open each via `open` (per memory) and
screenshot the slice panel + one function panel + one definition panel side by
side with Chrome tools, so the user can compare against the current
`review-spara-app-pr*.html`.

**Debug overlay (`--debug-marks`).** The branch made many more symbols
clickable and it is unclear *why* a given one is (or isn't) marked, or why it
is styled the way it is. The rerender script passes a new `--debug-marks` CLI
flag that makes the pane explain itself when **Shift is held**:

- Every mark carries a `data-why` attribute with its provenance. Emitted at
  the site that creates the mark:
  - `renderPanel` csite (`explorer.ts:114`): `csite · graph edge → <nodeId>`
  - `symbolMarks` (`sliceExplorer.ts:129`): `csite · text match of graph symbol <name> → <nodeId>`
  - `self-sym` (`explorer.ts:155`, `:218`): `decl · <name> (<kind>)` and
    whether it came from the language service or the text-search fallback
  - `NavIndex.linkMarks` (`navLinks.ts:74`): `sym · def <id> <name> (<kind>) in <file>` plus
    `panel`/`no panel`/`external`/`in-place`
  - `NavIndex.refSiteMarks`: `ref-site · call/reference of <id>`
- Identifiers that were considered but **not** linked also get a span, so the
  absence is explained too. `resolveNavigation` records an outcome per
  identifier it visits when the flag is on — `NavigationData.debug?:
  Record<file, {line,start,end,why}[]>` — with reasons like `no definition`,
  `definition is the identifier itself`, `local variable (scope <fn>)`,
  `lookup budget exhausted`, `panel budget exhausted`, `external, no window`,
  `not visible line (priority <n>)`. `NavIndex.marksFor` turns these into
  `<span class="id-dbg" data-why>` marks (no click behaviour, no styling
  unless Shift is held). Identifiers never visited (outside `visibleLines`)
  are marked `not visited` by the pane from `identifiersOf`.
- Client: `keydown`/`keyup` on Shift toggles `body.debug-marks`. CSS:
  `.debug-marks [data-why]` gets a thin outline colour-coded per class, and
  `::after { content: attr(data-why) }` renders a tiny (0.6rem) label above
  the span; `.id-dbg` spans are invisible otherwise. Also show a legend chip
  in the corner listing class → colour → meaning while Shift is held.
- None of this ships in the normal page: without the flag no `data-why`,
  no `.id-dbg`, no debug JS/CSS is emitted (guarded in the renderers and
  asserted by a test).

Iterate on the user's feedback until they sign off. **Do not start Stage 2
until they do.** Commit Stage 1 on its own.

### Tests (Stage 1)
- `diffView.test.ts`: `fragmentDiffRows` — context merge, deletion-only fragment
  between two lines, no-entry fallback, trailing gap.
- `sliceExplorer.test.ts`: slice panel now emits `.code-pane` / `.scope-bar[data-key]`,
  no `.file-block`; stats present; `data-target` csite marks still present.
- `explorer.test.ts` / `html.test.ts`: existing assertions updated for the
  unified header markup.
- `navigation.test.ts` / `sliceExplorer.test.ts`: with `debugMarks` on, visited
  identifiers carry `data-why` (linked and unlinked); with it off, no
  `data-why`/`.id-dbg` anywhere in the output.
- `pnpm --filter @deep-review/call-graph test`, then `pnpm test`.

---

## Stage 2 — Local server, on-demand LSP

### Server — `packages/review/src/serve.ts` (new)

`node:http` on `127.0.0.1`, random port (no new deps; `@hono/node-server` is
available if routing gets hairy, but four routes don't need it). Holds:
`Backends(headDir)` (`backends.ts:13`), the `FileIndex`, the rendered page, and
a `NavSession`:

```ts
class NavSession {
  defs = new Map<string, DefinitionTarget>();          // id → target
  ids  = new Map<string, DefinitionId>();               // "file:line:col" → id
  panels = new Map<DefinitionId, string>();             // rendered HTML cache
  async definition(file, line, col): Promise<DefinitionTarget | null>  // definitionAt + attachPanel logic
  async references(id): Promise<ReferenceList>                         // incomingCallsAt ?? referencesAt, no cap
  async panel(id): Promise<string>                                     // renderDefinitionPanel, cached
}
```
Reuse from `navigation.ts`: the def-key/id assignment (`:171-174`), the window
extraction (`WINDOW_CONTEXT`/`WINDOW_MAX_LINES`, `attachPanel` `:234`),
`collectReferences` (`:317`) minus `maxReferences`, and `enclosingPanel`
(`:291`) so each reference site gets a `panelId`. Keep `visibleLines`'s
`identifiersOf` tokenizer only for the client-side identifier spans.

Routes (all JSON unless noted, all `Cache-Control: no-store`):
- `GET /` → the explorer HTML (`text/html`).
- `GET /definition?file&line&col` → `{ id, name, kind, panelId, inPlace: {file,line,col} } | null`
- `GET /references?id` → `ReferenceList` with `panelId` per site (server renders
  and caches the enclosing panel so the row can open immediately).
- `GET /panel?id` → `{ id, name, html }` (`text/html` body is fine too).
- `POST /shutdown` and a `beforeunload` ping from the page, plus exit when
  stdin closes / SIGINT. `Backends.dispose()` on exit.

The checkout worktree must outlive generation: `prepareCheckouts` already
caches under `os.tmpdir()/deep-review/<owner>-<repo>-pr<n>`; the server just
holds it open. Log the URL and "press Ctrl-C to stop".

### CLI — `packages/review/src/cli.ts`
- Drop `--no-nav`, `--nav-budget`; add `--port <n>`, keep `--out` (writes the
  static page too, for archiving — it works minus navigation) and `--no-open`.
- After `renderSliceExplorerHtml`, start the server and `open` the URL.
- `build.ts:183`: remove the `resolveNavigation` call; `SliceExplorerInput.nav`
  goes away. Delete `navigation.ts` + its test once nothing imports it.

### Page — one click mechanism
- Every identifier gets a bare `<span class="id">` (from `identifiersOf`,
  applied in `renderLine` via marks with no attrs). No `data-target`/`data-def`
  baked in. `.csite` from call-graph edges and `symbolMarks` are removed — the
  server answers those clicks too (a graph node's panel id = its `nodeId`,
  which the server maps from the definition site so existing per-slice
  `.panel-defs` function panels are still found first by `panelFor`).
- Click handler (`EXPLORER_NAV_JS`, `explorer.ts:484`): resolve `(file, line,
  col)` from the row's `.scope-bar[data-key]`, the `.line` number, and the
  span's text offset; `fetch('/definition')`. If `inPlace` matches a visible
  `.self-sym`, `linkInPlace`; else `panelFor(id)` (now async: check
  `.panel-defs`/`#shared-defs`, else `fetch('/panel')`, insert into
  `#shared-defs`, clone). `walkDown`/`walkUp` become async wrappers; history
  restore uses the same path.
- Cmd-click → `fetch('/references')`, then `openRefMenu` renders rows from the
  response; `window.REFS`, `#ref-data`, `#def-names` blobs go away (names come
  with the response). Show "resolving…" in the menu while awaiting; the
  "+N more" row disappears since nothing is capped.
- `NavIndex` (`navLinks.ts`) shrinks to the `.self-sym`/`data-decl` mark for
  panels rendered by the server; `linkMarks`/`refSiteMarks` from precomputed
  data are removed. `.ref-site` highlighting after a walk-up uses the site's
  `line/startColumn` from the response instead.

### Tests (Stage 2)
- `serve.test.ts`: spin the server on a temp TS project (reuse the fixture
  approach from `navigation.test.ts`), hit `/definition`, `/references`,
  `/panel`; assert ids are stable across calls and panels are cached.
- `sliceExplorer.test.ts`: no nav blobs; `.id` spans present; fetch-based JS
  strings present.
- Pyright path: extend `pyGraph.test.ts` with one `/definition` round-trip.

---

## Verification

Stage 1: re-render the saved reports listed above, open them, compare panels
visually with the current `review-spara-app-pr*.html`; `pnpm test` green.
User signs off.

Stage 2: `pnpm --filter @deep-review/review cli --slices packages/review/slices-spara-app-pr10365.json`
→ browser opens `http://127.0.0.1:<port>/`; click a symbol in the slice panel
(panel slides in), click one inside that panel (second hop), cmd-click a
function name (callers menu, no "+N more"), click a row (walks up, site
highlighted), reload (history restores through async `panelFor`), Ctrl-C
stops the server and pyright exits. Generation time and page size drop
noticeably versus the current report (note both numbers).
