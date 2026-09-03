# Line-count breakdown: core / tests / boilerplate

GitHub shows a PR's total additions and deletions. This gives a higher-fidelity
version: per PR and per slice, additions and deletions split into **core**,
**tests**, and **boilerplate**.

## Decisions (settled in the grill)

- **Boilerplate** = mechanical changes: imports/exports, re-exports, renames,
  wiring/registration, config, lockfiles, generated files, formatting-only,
  type plumbing with no logic.
- **Tests** = changes that exercise core code. A test fragment that only
  exercises boilerplate is classified as boilerplate, not test.
- **Granularity**: one `kind` per fragment (`core | test | boilerplate`).
  When a run mixes kinds and the split is clean, the slicer splits it into
  separate fragments; otherwise the fragment takes its dominant kind.
- **Reconciliation** is a hard invariant. The slicer only assigns kinds; all
  +/- counts are computed from the diff. Because `validate.ts` already
  requires every added/removed line to be in exactly one fragment, the per-
  slice bucket sums equal the PR totals by construction.
- **Persistence**: only `kind` is stored in the slice JSON. Counts are derived
  at render time (`loadRenderEntry` already re-derives the diff).
- **Old reports** without `kind` render an unsplit `+N −M`.
- **Display**: stacked proportional bar (weighted by additions + deletions)
  plus text per bucket, zero buckets hidden. Replaces the `N fragments` and
  `N lines` badges in the slice header; `files`, `target`, and `no call graph`
  badges stay. Same bar + text under the PR title in the sidebar.
- **Scope**: explorer only (`packages/call-graph/src/sliceExplorer.ts`). The
  legacy renderer `packages/slicer/src/html.ts` is untouched.

## Changes

### 1. Slicer schema and types (`packages/slicer`)

- `src/schema.ts`: add `kind: z.enum(["core","test","boilerplate"])` to
  `agentFragmentSchema` (required) with a `.describe()` carrying the
  definitions above. Add `kind` as **optional** to the fragment in
  `sliceReportSchema` so old JSON still parses.
- `src/types.ts`: `export type FragmentKind = "core" | "test" | "boilerplate"`;
  `Fragment.kind?: FragmentKind`.
- Wherever agent output is converted to `Fragment` (the id-assigning step in
  `slice.ts` / the validate path), carry `kind` through.

### 2. Slicer prompt (`packages/slicer/src/agent.ts`)

Add a `## Classifying fragments` section after `## Fragments`:

- Every fragment gets a `kind`.
- `core`: the behavior the PR exists to change, and the supporting logic it
  needs.
- `boilerplate`: mechanical fallout (list above). Test: would a reviewer
  skim it rather than read it?
- `test`: test code that exercises core changes. Tests that only exercise
  boilerplate are `boilerplate`.
- When a contiguous run mixes kinds, split it into separate fragments rather
  than picking a dominant kind, when the split is clean.
- The ordering section already mentions tests and mechanical fallout;
  cross-reference it rather than duplicating.

### 3. Counting (new `packages/slicer/src/stats.ts`)

Pure functions, unit-tested:

```ts
export interface LineDelta { additions: number; deletions: number }
export type KindTotals = Record<FragmentKind, LineDelta>;
export function fragmentDelta(fragment, index): LineDelta   // count "+"/"-" prefixes in hunk.lines[start-1..end)
export function sliceTotals(slice, index): KindTotals | LineDelta  // LineDelta when any fragment lacks kind
export function reportTotals(report, index): KindTotals | LineDelta
```

Extend `DiffIndex` with `additions`/`deletions` next to `changedLineCount`
(`annotate.ts:77`). `reportTotals` asserts the bucket sums equal those and
throws on drift.

### 4. Explorer input (`packages/review/src/build.ts`, `packages/call-graph/src/sliceExplorer.ts`)

- `SliceFragmentInput.kind?: FragmentKind` (set in `fragmentInput`).
- The explorer already receives each fragment's raw `lines` with `+`/`-`
  prefixes, so it can count per bucket itself from `lines` + `kind`. This
  keeps `call-graph` free of a dependency on `slicer` internals; `build.ts`
  only threads `kind`. The `stats.ts` functions in step 3 serve the
  reconciliation check and any non-explorer consumer.

### 5. Explorer rendering (`packages/call-graph/src/sliceExplorer.ts`)

- New helper `renderDeltaBreakdown(totals, { compact })` returning
  `<div class="delta">` with a `<div class="delta-bar">` of up to three
  `<span class="seg core|test|boilerplate" style="flex:N">` and a text row
  `core +120 −30 · tests +80 −5 · boilerplate +12 −4` (zero buckets hidden).
  For unsplit `LineDelta`: a single neutral segment and `+N −M`.
- `renderSlicePanel` (~lines 130-145): drop the `fragments` and `lines`
  badges; insert the breakdown before the `files` badge.
- Sidebar (~line 654): insert the compact breakdown under `.pr-title`.
- CSS in `SLICE_CSS`: bar height 4px, three distinct colors with a neutral
  fallback; text uses existing `.badge` typography.

### 6. Tests

- `packages/slicer/src/stats.test.ts`: fragment counting with context lines,
  pure-deletion fragments, `\ No newline` lines; slice/report totals; kind
  missing → `LineDelta`; reconciliation assertion.
- `packages/slicer/src/validate.test.ts`: agent output without `kind` is
  rejected; persisted report without `kind` still loads.
- `packages/call-graph/src/sliceExplorer.test.ts`: header shows per-bucket
  text and bar segments, hides zero buckets, no `fragments`/`lines` badges;
  sidebar shows the PR breakdown; old-style input renders unsplit `+N −M`.
- `packages/review/src/build.test.ts`: `kind` threads through.

### 7. Verification

- `pnpm -r test` (vitest in each package).
- Re-render a saved report (`packages/review/scripts/rerender.sh`) to confirm
  the unsplit fallback for old JSON.
- Run the slicer on one real PR to confirm the model emits `kind` and totals
  reconcile with `git diff --numstat`.

## Out of scope

- Fetching GitHub's `additions`/`deletions` (the diff from git is the source
  of truth; the invariant is against the diff).
- Updating `packages/slicer/src/html.ts`.
- Index page (`packages/review/src/indexPage.ts`) sizes.
