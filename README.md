# Deep Review

A full-stack TypeScript tool for code review.

Project vocabulary lives in [CONTEXT.md](./CONTEXT.md).

## Quick start

```sh
pnpm install
pnpm dev        # server on :3001, web on :5173
```

Then, to view a PR in the slice explorer — the tool's primary interface,
stacking slices vertically and each slice's call graph horizontally — run it
against any GitHub PR URL:

```sh
export OPENAI_API_KEY=...   # or ANTHROPIC_API_KEY / GROK_API_KEY, see below
pnpm --filter @deep-review/review cli https://github.com/vercel/swr/pull/2950
```

This slices the PR with an agent, walks a call graph from each slice's
target function, and opens the rendered report (`review-<repo>-pr<n>.html`)
in your browser. See [The slice explorer](#the-slice-explorer) below for
options, and [PR slicing](#pr-slicing) for the environment variables it
needs.

## Structure

- `apps/server` — [Hono](https://hono.dev) API on Node. Reviews and findings, backed by an in-memory store (swap in a database via `src/store.ts`).
- `apps/web` — Vite + React UI. Proxies `/api` to the server in dev.
- `packages/shared` — Zod schemas and types shared by both (reviews, findings, severities).
- `packages/pr` — one PR's raw material: URL parsing, GitHub metadata, linked Linear tickets, base/head worktrees, and unified-diff parsing. Depended on by the two analysis packages below.
- `packages/call-graph` — analyze how a function's callers/callees change across a GitHub PR, using the TypeScript language service's call hierarchy. Includes an HTML report generator and CLI.
- `packages/slicer` — break a PR's diff into prioritized slices with an agent. Includes a CLI.
- `packages/review` — the two together: slices on the vertical axis, call graphs on the horizontal. Includes the `pr-review` CLI.

## Getting started

```sh
pnpm install
pnpm dev        # server on :3001, web on :5173
```

## Scripts

Run from the repo root:

| Command          | What it does                          |
| ---------------- | ------------------------------------- |
| `pnpm dev`       | Start server and web app in watch mode |
| `pnpm build`     | Build every package                   |
| `pnpm typecheck` | Type-check every package              |
| `pnpm test`      | Run all tests (Vitest)                |

## API

- `GET /api/health`
- `GET /api/reviews` · `POST /api/reviews`
- `GET /api/reviews/:id` · `PATCH /api/reviews/:id/status`
- `GET /api/reviews/:id/findings` · `POST /api/reviews/:id/findings`

Request/response shapes live in `packages/shared/src/index.ts`.

## PR call-graph analysis

Given a PR URL and a function name, `@deep-review/call-graph` checks out the
PR's base and head commits, asks the TypeScript language service for the
function's callers (incoming calls) and callees (outgoing calls) in each
revision, and pairs every related function with the PR diff hunks that touch
it.

```sh
pnpm --filter @deep-review/call-graph cli \
  https://github.com/sindresorhus/ky/pull/874 calculateRetryDelay \
  --out report.html
```

The HTML report shows callers above the target function and callees below,
each entry collapsible, with a Before / After / Both toggle. Source is
syntax-highlighted; the exact call to the target is marked inside each
caller; elided regions get GitHub-style expanders (20 lines per click) with
a breadcrumb of the enclosing symbols. `--layout columns` renders a
two-pane sliding variant: callers | target by default; clicking a call site
in the target's source slides the panes left (iOS-style) to show
target | callee, with thin clickable rails on either edge to slide back and
forth. `--layout explorer` goes further: it recursively walks the call graph
out from the function in both directions, expanding through every function
the PR changed and stopping at the first unchanged caller/callee boundaries.
Each function is a panel in the same two-pane slider — tap a highlighted
call to walk down the stack, tap a "called by" row to walk up — so a change
that cuts deep through the stack can be traced end to end from either
boundary. Use `--json` for the raw result instead. Programmatic use:

```ts
import { analyzePrCallGraph, createCallGraphReport } from "@deep-review/call-graph";

const result = await analyzePrCallGraph({ prUrl, functionName }); // data
await createCallGraphReport({ prUrl, functionName, outFile });    // data + HTML page
```

Languages: TypeScript/JavaScript are analyzed with an in-process TypeScript
language service; Python with `pyright-langserver` over LSP (bundled — no
install needed). The backend is chosen per PR from which file types the diff
touches, falling back across languages when the function isn't found.

Notes: set `GITHUB_TOKEN` for private repos; `#private` methods can be named
with or without the `#`; the clone is cached per-PR under the system tmp dir
(override with `--work-dir`). Dependencies of the analyzed repo are not
installed, so calls that resolve through `node_modules` / site-packages may
be missed.

## PR slicing

`@deep-review/slicer` reads a PR the way a reviewer would decide where to
start: it takes the description, any linked Linear tickets, and the whole
diff, and returns the changes grouped into **slices** — each accomplishing
one coherent thing — ordered from most to least central to the PR's purpose.

```sh
export ANTHROPIC_API_KEY=...
pnpm --filter @deep-review/slicer cli https://github.com/vercel/swr/pull/2950
```

The unit a slice holds is a **fragment**: a contiguous run of lines within
one hunk. Hunks are too coarse to assign — a newly added file is a single
hunk that may serve several purposes — so the agent cuts them finer, and its
fragments must partition the diff: every added and removed line in exactly
one slice. That is checked mechanically, and violations are handed back for
repair rather than persisted, because a change assigned to no slice looks
exactly like one that was considered and ranked last.

The PR's metadata, tickets, and diff are fetched in plain code rather than by
the agent — they are known-required inputs, and making the model discover
them spends turns without adding judgment. What the agent gets tools for is
the part that needs looking around: `read_file`, `list_directory`, and
`search` (git grep), read-only over the base and head worktrees, so it can
tell a load-bearing change from mechanical fallout.

Output is a JSON file (`slices-<repo>-pr<n>.json`) validated against a Zod
schema. Each slice may name a `target` function, which is the seam to the
call-graph tool above: the target of the first slice is the entry point for
the deepest-value walk of the PR.

```ts
import { slicePr, writeSliceReport } from "@deep-review/slicer";

const report = await slicePr({ prUrl });
writeSliceReport(report, "slices.json");
```

Add `--html <file>` for a report page: each slice in priority order with its
summary, the reasoning behind its rank, and the actual diff lines every one
of its fragments claims. Because the slices partition the diff, the page
shows each changed line exactly once, under the one slice that owns it.

Rendering is separable from slicing, so a saved run can be re-rendered — or
several PRs combined into one page with a tab each — without paying for the
agent again:

```sh
pnpm --filter @deep-review/slicer cli --render \
  slices-spara-app-pr10169.json slices-spara-app-pr9986.json \
  --html pr-slices.html
```

Use `--dry-run` to print the exact prompt (including the annotated diff)
without spending a model call. The model defaults to `claude-opus-5`,
overridable with `--model` or `DEEP_REVIEW_MODEL`.

Environment: `ANTHROPIC_API_KEY` is required (a `.env` in the package or repo
root is picked up automatically), `GITHUB_TOKEN` for private repos,
`LINEAR_API_KEY` optional — without it, ticket references are reported and
skipped rather than failing the run.

## Watching your assigned PRs

`pr-review watch` turns the whole thing around: instead of asking for a
review, a review is waiting when a PR is assigned to you.

```sh
pr-review watch          # on; survives logout, reboot and a closed lid
pr-review status         # what is being watched, and what the server holds
pr-review watch --off    # off
```

It checks GitHub every five minutes (`--interval <seconds>`) for the PRs
waiting on your review, and hands each new one to the same long-lived server
every other invocation uses — starting it if it is not up, so there is never
a server to start yourself. New PRs simply appear on the server's index,
built and ready.

"Waiting on your review" is narrower than "assigned to you", and deliberately:
a draft is not ready to be read, and one you have already approved has been
read. Both are excluded, so the list is work outstanding rather than
everything carrying your name. `--repo <owner>/<repo>` (or `DEEP_REVIEW_REPO`,
the same one a bare PR number uses) narrows it to a single repo; without one
it watches every repo your token can see. The query is exactly:

```
is:open is:pr assignee:@me archived:false -is:draft -review:approved [repo:<owner>/<repo>]
```

The check asks for the *current* set of such PRs rather than for events,
which is what makes a laptop the right place to run it: a webhook delivered to
a sleeping machine is lost, but one poll after the lid opens sees everything
that happened overnight. Missing a check costs nothing by construction.

A PR is handed over once, when it first appears in that list — not every time
it changes, because `updated_at` moves on every comment and a rebuild means a
paid slicing run. Anything that drops out of the list is forgotten, so
approving a PR and having it reassigned, or unassigning and reassigning, is
the deliberate way to ask for it again.

Turning it on installs a launchd agent (`com.deep-review.watcher`), which is
what carries it across reboots. Two consequences worth knowing:

- **Keys are captured at install time.** launchd sources no shell profile, so
  the agent can only have what your shell had when you ran `watch`. It refuses
  to install without a model key and a GitHub token rather than failing at 3am,
  and stores them in `~/.deep-review/watcher.env` (mode 0600) rather than in
  the plist, which lives in a world-readable directory.
- **Install from a permanent checkout.** The agent points at the exact
  interpreter and CLI path that installed it, so installing from a git
  worktree or a temp dir gives you something that breaks silently when that
  path is removed. `watch` refuses those paths; `--force` overrides.

State lives beside the server's, under `~/.deep-review` (`$DEEP_REVIEW_HOME`):
`watcher.json` for what has been handed over, `watcher.log` for what the
agent has been doing. `pr-review stop` stops watching and stops the server.

## The slice explorer

`@deep-review/review` fuses the two. Slices stack on the **vertical** axis in
priority order; each slice's call graph walks on the **horizontal** axis.

```sh
pnpm --filter @deep-review/review cli https://github.com/vercel/swr/pull/2950
```

It slices the PR, walks a call graph from each slice's named `target`, then
serves the page from a local **navigation server** (`http://127.0.0.1:<port>/`)
and opens it; Ctrl-C stops the server, as does closing the page. The server
keeps the language services warm over the PR's head checkout and answers
symbol clicks on demand — where a symbol is defined, who calls it, the panel
for a definition nothing on the page had shown yet — so nothing is resolved
ahead of time and nothing is capped. `--out <file>` also writes a static copy
(readable, but symbol clicks are inert without the server); `--no-serve`
writes that copy and exits. Reuse a previous slicing run with
`--slices <file>` to skip the agent entirely — that is the fast loop while
iterating on the page itself; `scripts/rerender.sh` wraps it for a batch of
saved reports.

In place of the URL you can pass just the PR number, as long as something
names the repo it belongs to — `--repo <owner>/<repo>`, or the
`DEEP_REVIEW_REPO` environment variable:

```sh
pnpm --filter @deep-review/review cli 2950 --repo vercel/swr
```

Vertically, scrolling inside a slice behaves normally until its content runs
out; pushing past the bottom carries you to the next slice, past the top to
the previous one, landing at the edge you were heading toward so the motion
reads as one continuous column. A firm flick clears the threshold, a coasting
scroll that merely lands on the boundary does not. Pips, PageUp/PageDown, and
labelled rails at the top and bottom do the same thing deliberately.

Horizontally, each slice starts at its **slice panel** — the slice's title,
reasoning, and every fragment's diff. Any identifier in that diff is
tappable: the server resolves it, and its panel slides in exactly as the
standalone explorer does (a call-graph function's own panel when it has one,
a definition panel otherwise; a declaration already in view lights up in
place instead). ⌘-click a symbol — a newly declared function included — for
a menu of everything that calls or references it, and tap a row to walk up
into the caller with the call site highlighted. From there the usual walk up
(called-by rows) and down (call marks) applies. Each slice keeps its own
track and position, so walking deep into one slice's callers leaves the
others where you left them.

A slice only gets a horizontal axis if it named a target and the language
service could resolve it. Slices without one still render — their diff is all
there is to see, and the badge says so. Graph analysis is the slow part
(~10-15s per slice), so `--max-graphs <n>` caps it, and a slice whose analysis
fails is reported rather than silently dropped.

## A note on the diff both tools analyze

`prepareCheckouts` compares the PR's **merge base** to its head, not GitHub's
`base.sha` to its head. GitHub reports `base.sha` as the current tip of the
base branch, so on a branch that has fallen behind, diffing against it pulls
in every unrelated commit that landed on the base since — on one stale PR
that was the difference between 1,025 changed lines and 26,911. The merge
base is what GitHub's own "Files changed" compares against, so both the
call-graph walk and the slicer now see the same diff a reviewer does. The
base worktree is checked out at the merge base to match.
